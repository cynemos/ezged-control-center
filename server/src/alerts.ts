import { config } from './config.js';
import type { Db } from './db.js';
import { notify } from './notify.js';
import type { Inventory, Snapshot } from './types.js';

export type Severity = 'warning' | 'critical';

export interface Finding {
  rule: string; // clé stable, ex. "disk:C:" ou "service:EzGED"
  severity: Severity;
  message: string;
}

// Seuils d'alerte. À ajuster selon le parc.
export const THRESHOLDS = {
  diskWarnPct: 90,
  diskCritPct: 95,
  memWarnPct: 95,
  cpuWarnPct: 90, // moyenne des 5 dernières mesures
  backupWarnHours: 26,
  backupCritHours: 50,
  queueWarnMinutes: 60,
  certWarnDays: 15,
  certCritDays: 3,
};

/** Services surveillés : une alerte critique s'ils ne tournent pas. */
export const CRITICAL_SERVICES = ['Apache2.4', 'EzGED', 'MySQL'];

function duration(minutes: number): string {
  if (minutes < 120) return `${Math.round(minutes)} min`;
  if (minutes < 2880) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} j`;
}

export function evaluate(snap: Snapshot, inv: Inventory | null, recentCpu: number[]): Finding[] {
  const out: Finding[] = [];
  const m = snap.metrics ?? {};

  for (const d of m.disks ?? []) {
    if (d.usedPct >= THRESHOLDS.diskCritPct)
      out.push({ rule: `disk:${d.name}`, severity: 'critical', message: `Disque ${d.name} plein à ${d.usedPct} % (${d.freeGB} Go libres)` });
    else if (d.usedPct >= THRESHOLDS.diskWarnPct)
      out.push({ rule: `disk:${d.name}`, severity: 'warning', message: `Disque ${d.name} plein à ${d.usedPct} % (${d.freeGB} Go libres)` });
  }

  if (typeof m.memUsedPct === 'number' && m.memUsedPct >= THRESHOLDS.memWarnPct)
    out.push({ rule: 'mem', severity: 'warning', message: `Mémoire utilisée à ${m.memUsedPct} %` });

  if (recentCpu.length >= 5) {
    const avg = recentCpu.reduce((a, b) => a + b, 0) / recentCpu.length;
    if (avg >= THRESHOLDS.cpuWarnPct)
      out.push({ rule: 'cpu', severity: 'warning', message: `CPU moyen à ${Math.round(avg)} % sur 5 minutes` });
  }

  for (const s of snap.services ?? []) {
    if (CRITICAL_SERVICES.includes(s.name) && s.status !== 'Running')
      out.push({ rule: `service:${s.name}`, severity: 'critical', message: `Service ${s.name} : ${s.status}` });
  }

  if (snap.http && !snap.http.ok)
    out.push({
      rule: 'http',
      severity: 'critical',
      message: `Serveur EzGED injoignable (${snap.http.url}) : ${snap.http.error ?? `HTTP ${snap.http.status}`}`,
    });

  if (snap.web && !snap.web.ok)
    out.push({
      rule: 'web',
      severity: 'critical',
      message: `Page EzGED inaccessible (${snap.web.url}) : ${snap.web.error ?? `HTTP ${snap.web.status}`}`,
    });

  if (snap.backup) {
    const age = snap.backup.ageHours;
    if (age === null || age === undefined)
      out.push({ rule: 'backup', severity: 'critical', message: `Aucune sauvegarde trouvée dans ${snap.backup.dir}` });
    else if (age >= THRESHOLDS.backupCritHours)
      out.push({ rule: 'backup', severity: 'critical', message: `Dernière sauvegarde il y a ${Math.round(age)} h` });
    else if (age >= THRESHOLDS.backupWarnHours)
      out.push({ rule: 'backup', severity: 'warning', message: `Dernière sauvegarde il y a ${Math.round(age)} h` });
  }

  for (const [name, q] of Object.entries(snap.queues ?? {})) {
    if (q.oldestMin !== null && q.oldestMin >= THRESHOLDS.queueWarnMinutes)
      out.push({
        rule: `queue:${name}`,
        severity: 'warning',
        message: `File ${name} : ${q.count} fichier(s), le plus ancien attend depuis ${duration(q.oldestMin)}`,
      });
  }

  if (snap.db && !snap.db.ok)
    out.push({ rule: 'db', severity: 'critical', message: `Connexion MariaDB impossible : ${snap.db.error ?? 'erreur inconnue'}` });

  for (const c of inv?.certificates ?? []) {
    if (c.daysLeft <= THRESHOLDS.certCritDays)
      out.push({ rule: `cert:${c.file}`, severity: 'critical', message: `Certificat ${c.subject} expire dans ${c.daysLeft} j` });
    else if (c.daysLeft <= THRESHOLDS.certWarnDays)
      out.push({ rule: `cert:${c.file}`, severity: 'warning', message: `Certificat ${c.subject} expire dans ${c.daysLeft} j` });
  }

  return out;
}

interface OpenAlert {
  id: number;
  rule: string;
  severity: Severity;
  message: string;
}

type Log = (msg: string) => void;

async function serverLabel(db: Db, serverId: string): Promise<string> {
  const [row] = await db.query<{ label: string }>(
    `SELECT COALESCE(c.name || ' / ', '') || COALESCE(s.display_name, s.hostname) AS label
       FROM servers s LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = $1`,
    [serverId],
  );
  return row?.label ?? serverId;
}

/**
 * Synchronise les alertes ouvertes d'un serveur avec les constats.
 * scope = 'report' : toutes les règles sauf "offline" sont gérées, et "offline" est fermée (le serveur a parlé).
 * scope = 'offline' : seule la règle "offline" est ouverte.
 */
export async function syncAlerts(db: Db, serverId: string, findings: Finding[], scope: 'report' | 'offline', log: Log) {
  const open = await db.query<OpenAlert>(
    'SELECT id, rule, severity, message FROM alerts WHERE server_id = $1 AND closed_at IS NULL',
    [serverId],
  );
  const openByRule = new Map(open.map((a) => [a.rule, a]));
  const label = await serverLabel(db, serverId);

  for (const f of findings) {
    const existing = openByRule.get(f.rule);
    if (!existing) {
      await db.query('INSERT INTO alerts (server_id, rule, severity, message) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
        serverId,
        f.rule,
        f.severity,
        f.message,
      ]);
      void notify(`[EzMon] ${f.severity === 'critical' ? 'CRITIQUE' : 'Alerte'} – ${label}`, f.message, log);
    } else if (existing.severity !== f.severity || existing.message !== f.message) {
      await db.query('UPDATE alerts SET severity = $2, message = $3 WHERE id = $1', [existing.id, f.severity, f.message]);
      if (existing.severity === 'warning' && f.severity === 'critical')
        void notify(`[EzMon] CRITIQUE – ${label}`, f.message, log);
    }
  }

  if (scope === 'report') {
    const active = new Set(findings.map((f) => f.rule));
    for (const a of open) {
      if (!active.has(a.rule)) {
        await db.query('UPDATE alerts SET closed_at = now() WHERE id = $1', [a.id]);
        void notify(`[EzMon] Résolu – ${label}`, a.message, log);
      }
    }
  }
}

/** Ouvre une alerte "offline" pour chaque serveur muet depuis plus de OFFLINE_MINUTES. */
export async function checkOffline(db: Db, log: Log) {
  const rows = await db.query<{ id: string; last_seen: Date }>(
    `SELECT id, last_seen FROM servers
      WHERE last_seen IS NOT NULL AND last_seen < now() - ($1 || ' minutes')::interval`,
    [String(config.offlineMinutes)],
  );
  for (const r of rows) {
    const minutes = Math.round((Date.now() - new Date(r.last_seen).getTime()) / 60_000);
    await syncAlerts(
      db,
      r.id,
      [{ rule: 'offline', severity: 'critical', message: `Aucun rapport de l'agent depuis ${minutes} min` }],
      'offline',
      log,
    );
  }
}
