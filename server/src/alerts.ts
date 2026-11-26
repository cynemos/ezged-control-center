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
  agentSlowMs: 45_000, // collecte anormalement longue (la tâche est coupée à 5 min)
  agentSlowInventoryMs: 180_000, // idem avec l'inventaire horaire (Windows Update lent sur 2008 R2 / 2012)
  processRestartMinutes: 15, // service redémarré récemment
  backupWarnHours: 26,
  backupCritHours: 50,
  // Veeam : souvent planifié du lundi au vendredi, d'où une marge couvrant le week-end (vendredi soir -> lundi soir = 72 h).
  veeamWarnHours: 74,
  veeamCritHours: 98,
  queueWarnMinutes: 60,
  dumpShrinkRatio: 0.5, // dump < 50 % du précédent : tronqué ou base vidée
  diskFullWarnDays: 30, // tendance : disque plein dans moins de 30 j / 7 j
  diskFullCritDays: 7,
  certWarnDays: 15,
  certCritDays: 3,
};

/** Services surveillés : une alerte critique s'ils ne tournent pas. */
export const CRITICAL_SERVICES = ['Apache2.4', 'EzGED', 'MySQL'];

/** Règle d'un des trois services sans lesquels la GED n'est plus utilisable (Apache, EzGED, MySQL). */
export function isGedRule(rule: string): boolean {
  return rule.startsWith('service:') && CRITICAL_SERVICES.includes(rule.slice('service:'.length));
}

/** Rappel tant qu'un service GED reste arrêté et que l'alerte n'est pas acquittée. */
export const GED_REMIND_MINUTES = 60;
const GED_IMPACT = "La GED n'est plus utilisable par les utilisateurs.";

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} Mo`;
}

function duration(minutes: number): string {
  if (minutes < 120) return `${Math.round(minutes)} min`;
  if (minutes < 2880) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} j`;
}

export function evaluate(snap: Snapshot, inv: Inventory | null, recentCpu: number[], diskFullDays: number | null = null): Finding[] {
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

  for (const p of snap.processes ?? []) {
    if (!p.startedAt) continue;
    const min = (Date.now() - new Date(p.startedAt).getTime()) / 60_000;
    // Seulement si la machine tourne depuis plus longtemps : un redémarrage du serveur n'est pas un incident de service.
    const upMin = (m.uptimeHours ?? 0) * 60;
    if (min >= 0 && min < THRESHOLDS.processRestartMinutes && upMin > THRESHOLDS.processRestartMinutes)
      out.push({ rule: `restart:${p.service}`, severity: 'warning', message: `Service ${p.service} redémarré il y a ${duration(min)}` });
  }

  const ag = snap.agent;
  if (ag?.errors?.length)
    out.push({
      rule: 'agent:errors',
      severity: 'warning',
      message: `Agent : collecte en échec (${ag.errors.map((e) => e.name).join(', ')}) – ${ag.errors[0].error}`,
    });
  if (ag?.durationMs && ag.durationMs >= (ag.inventory ? THRESHOLDS.agentSlowInventoryMs : THRESHOLDS.agentSlowMs))
    out.push({ rule: 'agent:slow', severity: 'warning', message: `Agent : collecte lente (${Math.round(ag.durationMs / 1000)} s)` });

  for (const h of snap.apache ?? []) {
    if (!h.ok)
      out.push({
        rule: `apache:${h.url}`,
        severity: 'critical',
        message: `Accès web Apache en échec (${h.url}) : ${h.error ?? `HTTP ${h.status}`}`,
      });
  }

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

  const v = snap.veeam;
  if (v) {
    if (v.service !== 'Running')
      out.push({ rule: 'veeam:service', severity: 'critical', message: `Service Veeam Agent : ${v.service}` });
    if (v.lastResult === 'Failed')
      out.push({ rule: 'veeam:result', severity: 'critical', message: `Sauvegarde Veeam${v.job ? ` « ${v.job} »` : ''} en échec${v.details ? ` : ${v.details}` : ''}` });
    else if (v.lastResult === 'Warning')
      out.push({ rule: 'veeam:result', severity: 'warning', message: `Sauvegarde Veeam${v.job ? ` « ${v.job} »` : ''} terminée avec avertissement${v.details ? ` : ${v.details}` : ''}` });
    const age = v.okAgeHours;
    if (age === null || age === undefined)
      out.push({ rule: 'veeam:age', severity: 'warning', message: 'Veeam installé mais aucune sauvegarde réussie dans le journal' });
    else if (age >= THRESHOLDS.veeamCritHours)
      out.push({ rule: 'veeam:age', severity: 'critical', message: `Dernière sauvegarde Veeam réussie il y a ${duration(age * 60)}` });
    else if (age >= THRESHOLDS.veeamWarnHours)
      out.push({ rule: 'veeam:age', severity: 'warning', message: `Dernière sauvegarde Veeam réussie il y a ${duration(age * 60)}` });
  }

  const b = snap.backup;
  if (b?.sizeBytes && b.prevSizeBytes && b.prevSizeBytes > 1_000_000 && b.sizeBytes < b.prevSizeBytes * THRESHOLDS.dumpShrinkRatio)
    out.push({
      rule: 'backup:size',
      severity: 'warning',
      message: `Dump ${b.lastFile ?? ''} anormalement petit : ${mb(b.sizeBytes)} contre ${mb(b.prevSizeBytes)} pour le précédent`,
    });

  if (diskFullDays !== null && diskFullDays < THRESHOLDS.diskFullWarnDays)
    out.push({
      rule: 'diskfull',
      severity: diskFullDays < THRESHOLDS.diskFullCritDays ? 'critical' : 'warning',
      message: `Au rythme des 7 derniers jours, disque plein dans ${Math.max(0, Math.round(diskFullDays))} j`,
    });

  const ev = snap.events;
  if (ev) {
    if (ev.bugchecks > 0)
      out.push({ rule: 'event:bugcheck', severity: 'critical', message: `Écran bleu (BugCheck) : ${ev.bugchecks} sur ${ev.hours} h` });
    if (ev.shutdowns > 0)
      out.push({ rule: 'event:shutdown', severity: 'warning', message: `Arrêt inattendu du serveur : ${ev.shutdowns} sur ${ev.hours} h` });
    if (ev.diskErrors > 0)
      out.push({ rule: 'event:disk', severity: 'critical', message: `Erreurs disque dans le journal Système : ${ev.diskErrors} sur ${ev.hours} h` });
    if (ev.ntfsErrors > 0)
      out.push({ rule: 'event:ntfs', severity: 'warning', message: `Erreurs NTFS (système de fichiers) : ${ev.ntfsErrors} sur ${ev.hours} h` });
  }

  for (const d of snap.disksHealth ?? []) {
    const bad = d.predictFailure === true || /unhealthy/i.test(d.health ?? '');
    const warn = /warning/i.test(d.health ?? '') || Boolean(d.status && !/^ok$/i.test(d.status));
    if (bad || warn)
      out.push({
        rule: `smart:${d.model}`,
        severity: bad ? 'critical' : 'warning',
        message: `Disque ${d.model} (${d.sizeGB} Go) : ${d.predictFailure ? 'panne prédite par SMART' : `état ${d.health ?? d.status}`}`,
      });
  }

  const dbLog = snap.logs?.mariadb;
  if (dbLog && dbLog.errors > 0)
    out.push({ rule: 'log:mariadb', severity: 'warning', message: `MariaDB : ${dbLog.errors} erreur(s) en 24 h – ${dbLog.last ?? ''}`.slice(0, 300) });

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
      if (isGedRule(f.rule)) void notify(`[EzGed ControlCenter] GED HORS SERVICE – ${label}`, `${f.message}\n${GED_IMPACT}`, log);
      else void notify(`[EzGed ControlCenter] ${f.severity === 'critical' ? 'CRITIQUE' : 'Alerte'} – ${label}`, f.message, log);
    } else if (existing.severity !== f.severity || existing.message !== f.message) {
      await db.query('UPDATE alerts SET severity = $2, message = $3 WHERE id = $1', [existing.id, f.severity, f.message]);
      if (existing.severity === 'warning' && f.severity === 'critical')
        void notify(`[EzGed ControlCenter] CRITIQUE – ${label}`, f.message, log);
    }
  }

  if (scope === 'report') {
    const active = new Set(findings.map((f) => f.rule));
    for (const a of open) {
      if (!active.has(a.rule)) {
        await db.query('UPDATE alerts SET closed_at = now() WHERE id = $1', [a.id]);
        void notify(`[EzGed ControlCenter] ${isGedRule(a.rule) ? 'GED rétablie' : 'Résolu'} – ${label}`, a.message, log);
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

const GED_RULES = CRITICAL_SERVICES.map((n) => `service:${n}`);

export interface Outage {
  id: string;
  name: string;
  client: string | null;
  since: string;
  lastSeen: string | null;
  online: boolean;
  acked: boolean;
  services: { alertId: number; name: string; message: string; since: string }[];
}

/** Serveurs dont au moins un des trois services GED est arrêté (alerte ouverte), le plus ancien en premier. */
export async function gedOutages(db: Db): Promise<Outage[]> {
  const rows = await db.query<{
    id: number;
    server_id: string;
    name: string;
    client: string | null;
    last_seen: Date | null;
    rule: string;
    message: string;
    opened_at: Date;
    acked: boolean;
  }>(
    `SELECT a.id, a.server_id, COALESCE(s.display_name, s.hostname) AS name, c.name AS client, s.last_seen,
            a.rule, a.message, a.opened_at, a.acked
       FROM alerts a JOIN servers s ON s.id = a.server_id LEFT JOIN clients c ON c.id = s.client_id
      WHERE a.closed_at IS NULL AND a.rule = ANY($1::text[])
      ORDER BY a.opened_at`,
    [GED_RULES],
  );
  const by = new Map<string, Outage>();
  for (const r of rows) {
    const since = new Date(r.opened_at).toISOString();
    let o = by.get(r.server_id);
    if (!o) {
      const lastSeen = r.last_seen ? new Date(r.last_seen).toISOString() : null;
      o = {
        id: r.server_id,
        name: r.name,
        client: r.client,
        since,
        lastSeen,
        online: Boolean(lastSeen && Date.now() - new Date(lastSeen).getTime() < config.offlineMinutes * 60_000),
        acked: true,
        services: [],
      };
      by.set(r.server_id, o);
    }
    o.services.push({ alertId: r.id, name: r.rule.slice('service:'.length), message: r.message, since });
    o.acked &&= r.acked;
  }
  return [...by.values()];
}

/** Rappel horaire des services GED toujours arrêtés, tant que l'alerte n'est pas acquittée. */
export async function remindGedOutages(db: Db, log: Log) {
  const due = await db.query<OpenAlert & { server_id: string; opened_at: Date }>(
    `UPDATE alerts SET reminded_at = now()
      WHERE closed_at IS NULL AND NOT acked AND rule = ANY($1::text[])
        AND COALESCE(reminded_at, opened_at) < now() - ($2 || ' minutes')::interval
      RETURNING id, server_id, rule, severity, message, opened_at`,
    [GED_RULES, String(GED_REMIND_MINUTES)],
  );
  for (const a of due) {
    const label = await serverLabel(db, a.server_id);
    const min = (Date.now() - new Date(a.opened_at).getTime()) / 60_000;
    void notify(
      `[EzGed ControlCenter] RAPPEL GED HORS SERVICE depuis ${duration(min)} – ${label}`,
      `${a.message}\n${GED_IMPACT}\nAcquitter l'alerte dans la console arrête les rappels.`,
      log,
    );
  }
}
