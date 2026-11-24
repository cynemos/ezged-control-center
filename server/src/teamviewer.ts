import { config } from './config.js';
import type { Db } from './db.js';

// Synchronisation avec la liste « Ordinateurs et contacts » du compte TeamViewer (API web, jeton de
// script en lecture seule). Chaque serveur est retrouvé par l'ID TeamViewer que remonte l'agent :
// le nom affiché suit le nom TeamViewer, sauf s'il a été saisi dans la console ; le client des
// fiches encore vides en est déduit. Une fiche dont l'appareil a disparu de TeamViewer est supprimée.

const API = 'https://webapi.teamviewer.com/api/v1';

export interface TeamViewerStatus {
  enabled: boolean;
  lastSyncAt: string | null;
  error: string | null;
  /** Source facultative non lue (droit manquant sur le jeton...), la synchronisation continue sans. */
  warning: string | null;
  devices: number;
  matched: number;
  updated: number;
  /** Serveurs dont l'ID TeamViewer n'est dans aucune liste lue (nom de machine et ID). */
  unmatched: string[];
  /** Fiches supprimées car leur appareil a disparu de TeamViewer (20 dernières depuis le démarrage). */
  removed: string[];
  /** Appareils disparus de TeamViewer dont la fiche sera supprimée (délai d'une heure, agent muet). */
  pendingRemoval: string[];
  /** Groupes TeamViewer suivis (TEAMVIEWER_GROUPS) et ceux effectivement trouvés dans le compte. */
  groups: { wanted: string[]; found: string[] };
  /** Appareils des groupes suivis sans agent de supervision (aucun serveur avec cet ID TeamViewer). */
  toDeploy: TvCandidate[];
}

export interface TvCandidate {
  tvId: string;
  alias: string;
  client: string | null;
  group: string;
  online: boolean | null;
  lastSeen: string | null;
  ignored: boolean;
  /** Nom identique à un serveur déjà supervisé : sans doute un ancien appareil ou un ancien ID TeamViewer. */
  sameNameAs: string | null;
}

export const tvStatus: TeamViewerStatus = {
  enabled: false,
  lastSyncAt: null,
  error: null,
  warning: null,
  devices: 0,
  matched: 0,
  updated: 0,
  unmatched: [],
  removed: [],
  pendingRemoval: [],
  groups: { wanted: [], found: [] },
  toDeploy: [],
};

// Segment de numérotation en tête des noms TeamViewer : « 15 », « 3.5 », « k15 », « 3.2# ».
const VERSION = /^[a-z]?\d+(?:\.\d+)*#?$/i;
// Même numérotation collée au nom, sans tiret : « 3.5 CAMPING FRONT DE MER ».
const VERSION_PREFIX = /^[a-z]?\d+(?:\.\d+)*#?\s+/i;
// Séparateur « - » entouré d'au moins un espace (« 3.5- ECBA ») ; « Saint-Jean » n'est pas coupé.
const SEP = /\s*-\s+|\s+-\s*/;

/** Nom fait uniquement de numéros (« k15 - 3.4 ») : pas un vrai client. */
export function isVersionOnly(name: string): boolean {
  return name.split(SEP).every((p) => VERSION.test(p.trim()));
}

/**
 * Client déduit du nom TeamViewer : sans les parenthèses (fermées ou non), sans les numéros en tête
 * ni le dernier segment (VM, new...). « 15 - 3.4 - C3SM CLAIRA - VM TJP » donne « C3SM CLAIRA » ;
 * « k15 - 3.5 - DERRO » donne « DERRO » ; « k15 - 3.4 - MAITRE CHERORET (S8614 - 5XZMZY1 » donne
 * « MAITRE CHERORET ».
 */
export function clientFromAlias(alias: string): string | null {
  const parts = alias
    .replace(/\s*\([^)]*\)?/g, ' ')
    .split(SEP)
    .map((p) => p.trim())
    .filter(Boolean);
  while (parts.length > 1 && VERSION.test(parts[0])) parts.shift();
  if (parts.length) parts[0] = parts[0].replace(VERSION_PREFIX, '');
  if (parts.length > 1) parts.pop();
  const name = parts.join(' - ').replace(/\s+/g, ' ').trim();
  return name && !isVersionOnly(name) ? name.slice(0, 100) : null;
}

function digits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

async function tvGet<T>(path: string): Promise<T> {
  const res = await fetch(API + path, {
    headers: { authorization: `Bearer ${config.teamviewerApiToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? `jeton refusé par TeamViewer (HTTP ${res.status}) pour ${path} : vérifier TEAMVIEWER_API_TOKEN et ses droits de lecture`
        : `API TeamViewer ${path} : HTTP ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

interface ManagedDevice {
  teamviewerId?: number | string;
  name?: string;
  isOnline?: boolean;
  lastSeen?: string;
}

/** Ressources de l'API « managed » (appareils, groupes d'appareils), paginées. */
async function managedDevices<T = ManagedDevice>(path: string): Promise<T[]> {
  const out: T[] = [];
  let token = '';
  for (let page = 0; page < 50; page++) {
    const body = await tvGet<{
      nextPaginationToken?: string;
      resources?: T[];
    }>(path + (token ? `?paginationToken=${encodeURIComponent(token)}` : ''));
    out.push(...(body.resources ?? []));
    if (!body.nextPaginationToken || body.nextPaginationToken === token) break;
    token = body.nextPaginationToken;
  }
  return out;
}

// Suppression des fiches dont l'appareil a disparu de TeamViewer : après une heure d'absence
// (plusieurs synchronisations, pour ne pas réagir à un incident de l'API), agent muet depuis
// 10 minutes, et jamais plus de MAX_REMOVALS fiches d'un coup.
const MISSING_GRACE_MS = 3600_000;
const SILENT_MS = 10 * 60_000;
const MAX_REMOVALS = 3;

let running: Promise<TeamViewerStatus> | null = null;
let again = false;
let timer: NodeJS.Timeout | null = null;

/** Synchronisation, une seule à la fois : un appel pendant qu'elle tourne en relance une à la suite. */
export function syncTeamViewer(db: Db, log: (msg: string) => void): Promise<TeamViewerStatus> {
  if (running) {
    again = true;
    return running;
  }
  running = run(db, log).finally(() => {
    running = null;
    if (again) {
      again = false;
      void syncTeamViewer(db, log);
    }
  });
  return running;
}

/** Synchronisation dans quelques secondes (nouvel agent) ; les demandes rapprochées n'en font qu'une. */
export function requestTeamViewerSync(db: Db, log: (msg: string) => void, delayMs = 5000): void {
  if (!config.teamviewerApiToken) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncTeamViewer(db, log);
  }, delayMs);
  timer.unref?.();
}

type Source = 'devices' | 'managed' | 'company' | 'groups';

async function run(db: Db, log: (msg: string) => void): Promise<TeamViewerStatus> {
  tvStatus.enabled = Boolean(config.teamviewerApiToken);
  if (!tvStatus.enabled) return tvStatus;
  try {
    // ID TeamViewer : nom, et listes où il figure.
    const aliases = new Map<string, { alias: string; sources: Set<Source> }>();
    const failed = new Set<Source>();
    const add = (id: unknown, alias: unknown, source: Source) => {
      const k = digits(id);
      const a = String(alias ?? '').trim();
      if (!k || !a) return;
      const e = aliases.get(k);
      if (e) e.sources.add(source);
      else aliases.set(k, { alias: a.slice(0, 200), sources: new Set([source]) });
    };
    // « Ordinateurs et contacts » : source principale, une erreur ici arrête la synchronisation.
    const body = await tvGet<{
      devices?: {
        remotecontrol_id?: string;
        teamviewer_id?: number;
        alias?: string;
        groupid?: string;
        online_state?: string;
        last_seen?: string;
      }[];
    }>('/devices');
    for (const d of body.devices ?? []) {
      add(d.remotecontrol_id, d.alias, 'devices');
      add(d.teamviewer_id, d.alias, 'devices');
    }
    const warnings: string[] = [];
    // Noms des groupes de la liste « Ordinateurs et contacts » (droit « Gestion des groupes »).
    const groupNames = new Map<string, string>();
    let groupsError: string | null = null;
    try {
      const g = await tvGet<{ groups?: { id?: string; name?: string }[] }>('/groups');
      for (const x of g.groups ?? []) if (x.id && x.name) groupNames.set(x.id, x.name);
    } catch (e) {
      groupsError = (e as Error).message;
    }
    // Appareils gérés (personnels puis de l'entreprise) : facultatifs, ils demandent le droit de
    // lecture « Gestion des appareils » sur le jeton.
    const managedErrors: string[] = [];
    for (const [path, source] of [
      ['/managed/devices', 'managed'],
      ['/managed/devices/company', 'company'],
    ] as const) {
      try {
        for (const d of await managedDevices(path)) add(d.teamviewerId, d.name, source);
      } catch (e) {
        failed.add(source);
        managedErrors.push((e as Error).message);
      }
    }
    const managedWarning = managedErrors.length
      ? `appareils gérés non lus (${managedErrors.join(' ; ')}) : ajouter au jeton le droit de lecture « Gestion des appareils »`
      : null;
    // Groupes d'appareils gérés suivis (droit « Groupes d'appareils ») : leurs appareils servent
    // aussi à retrouver les serveurs, et alimentent la liste des agents à déployer.
    const wanted = config.teamviewerGroups;
    const managedGroups: { name: string; devices: ManagedDevice[] }[] = [];
    let managedGroupsError: string | null = null;
    try {
      for (const g of await managedDevices<{ id?: string; name?: string }>('/managed/groups')) {
        if (!g.id || !g.name || !wanted.includes(g.name.toLowerCase())) continue;
        const devices = await managedDevices(`/managed/groups/${encodeURIComponent(g.id)}/devices`);
        managedGroups.push({ name: g.name, devices });
      }
    } catch (e) {
      managedGroupsError = (e as Error).message;
      failed.add('groups');
      managedGroups.length = 0;
    }
    for (const g of managedGroups) for (const d of g.devices) add(d.teamviewerId, d.name, 'groups');

    const rows = await db.query<{
      id: string;
      hostname: string;
      tv: string;
      display_name: string | null;
      name_source: string | null;
      client_id: number | null;
      client_name: string | null;
      last_seen: Date | null;
      tv_sources: string | null;
      tv_missing_since: Date | null;
    }>(
      `SELECT s.id, s.hostname, s.snapshot->>'teamviewerId' AS tv, s.display_name, s.name_source, s.client_id,
              c.name AS client_name, s.last_seen, s.tv_sources, s.tv_missing_since
         FROM servers s LEFT JOIN clients c ON c.id = s.client_id
        WHERE s.snapshot->>'teamviewerId' IS NOT NULL`,
    );
    let matched = 0;
    let updated = 0;
    const unmatched: string[] = [];
    const missing: typeof rows = [];
    for (const r of rows) {
      const entry = aliases.get(digits(r.tv));
      if (!entry) {
        unmatched.push(`${r.display_name || r.hostname} (${digits(r.tv)})`);
        // Déjà vu dans TeamViewer, et toutes les listes où il figurait ont été lues : il a disparu.
        const seenIn = (r.tv_sources ?? '').split(',').filter(Boolean);
        if (seenIn.length && seenIn.every((x) => !failed.has(x as Source))) {
          if (!r.tv_missing_since) await db.query('UPDATE servers SET tv_missing_since = now() WHERE id = $1', [r.id]);
          missing.push({ ...r, tv_missing_since: r.tv_missing_since ?? new Date() });
        }
        continue;
      }
      matched++;
      const alias = entry.alias;
      // Listes où il figure ; celles qui n'ont pas pu être lues gardent leur valeur précédente.
      const kept = (r.tv_sources ?? '').split(',').filter((x) => failed.has(x as Source));
      const sources = [...new Set<string>([...entry.sources, ...kept])].sort().join(',');

      let clientId: number | null = null;
      // Client fait uniquement de numéros (« k15 - 3.4 », déduit par la v0.4.4) : remplacé.
      const badClient = r.client_name !== null && isVersionOnly(r.client_name);
      const client = r.client_id === null || badClient ? clientFromAlias(alias) : null;
      if (client) {
        const [c] = await db.query<{ id: number }>(
          'INSERT INTO clients (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
          [client],
        );
        clientId = c.id;
      }
      // Nom : celui de TeamViewer, sauf saisie dans la console. Origine inconnue (fiches d'avant la
      // v0.8.0) : un nom différent du nom TeamViewer est considéré comme saisi à la main.
      const fromTv = !r.display_name || r.display_name === alias || r.display_name === alias.slice(0, 100);
      const nameSource = r.name_source ?? (fromTv ? 'tv' : 'manual');
      const name = nameSource === 'tv' ? alias.slice(0, 100) : r.display_name;
      const changed = name !== r.display_name || clientId !== null;
      if (changed || nameSource !== r.name_source || sources !== r.tv_sources || r.tv_missing_since) {
        await db.query(
          `UPDATE servers SET display_name = $2, name_source = $5, tv_sources = $6, tv_missing_since = NULL,
                  client_id = CASE WHEN $4::boolean THEN COALESCE($3, client_id) ELSE COALESCE(client_id, $3) END
            WHERE id = $1`,
          [r.id, name, clientId, badClient, nameSource, sources],
        );
      }
      if (changed) updated++;
    }

    // Fiches dont l'appareil a disparu de TeamViewer depuis assez longtemps, agent muet.
    const now = Date.now();
    const label = (r: (typeof rows)[number]) => r.display_name || r.hostname;
    const active = (r: (typeof rows)[number]) => r.last_seen !== null && now - new Date(r.last_seen).getTime() < SILENT_MS;
    const due = missing.filter((r) => now - new Date(r.tv_missing_since!).getTime() >= MISSING_GRACE_MS && !active(r));
    const removed: string[] = [];
    if (due.length > MAX_REMOVALS) {
      warnings.push(
        `${due.length} serveurs ont disparu de TeamViewer (${due.map(label).join(', ')}) : trop pour une suppression automatique, les supprimer à la main s'il le faut`,
      );
    } else {
      for (const r of due) {
        await db.query('DELETE FROM servers WHERE id = $1', [r.id]);
        removed.push(label(r));
        log(`Synchronisation TeamViewer : ${label(r)} (${digits(r.tv)}) supprimé, absent de TeamViewer`);
      }
    }
    const pendingRemoval = missing
      .filter((r) => !removed.includes(label(r)))
      .map((r) => (active(r) ? `${label(r)} (agent encore actif)` : label(r)));

    const orphans = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM clients c WHERE NOT EXISTS (SELECT 1 FROM servers s WHERE s.client_id = c.id)',
    );
    for (const o of orphans) if (isVersionOnly(o.name)) await db.query('DELETE FROM clients WHERE id = $1', [o.id]);

    // Agents à déployer : appareils des groupes suivis dont l'ID n'est remonté par aucun agent.
    const names = await db.query<{ tv: string | null; name: string }>(
      `SELECT snapshot->>'teamviewerId' AS tv, COALESCE(display_name, hostname) AS name FROM servers`,
    );
    const equipped = new Set(names.map((n) => digits(n.tv)).filter(Boolean));
    const byName = new Map(names.map((n) => [n.name.trim().toLowerCase(), n.name]));
    const ignored = new Set((await db.query<{ tv_id: string }>('SELECT tv_id FROM tv_ignored')).map((r) => r.tv_id));
    const found = new Set<string>();
    const toDeploy: TvCandidate[] = [];
    const seen = new Set<string>();
    const consider = (rawIds: unknown[], rawAlias: unknown, group: string, online: boolean | null, lastSeen: string | null) => {
      const ids = rawIds.map(digits).filter(Boolean);
      const tvId = ids[0];
      if (!tvId || ids.some((i) => seen.has(i) || equipped.has(i))) return;
      ids.forEach((i) => seen.add(i));
      const alias = String(rawAlias ?? '').trim() || tvId;
      toDeploy.push({
        tvId,
        alias,
        client: clientFromAlias(alias),
        group,
        online,
        lastSeen,
        ignored: ids.some((i) => ignored.has(i)),
        sameNameAs: byName.get(alias.toLowerCase()) ?? null,
      });
    };
    // 1. Groupes de la liste « Ordinateurs et contacts ».
    for (const d of body.devices ?? []) {
      const group = groupNames.get(d.groupid ?? '');
      if (!group || !wanted.includes(group.toLowerCase())) continue;
      found.add(group);
      consider(
        [d.remotecontrol_id, d.teamviewer_id],
        d.alias,
        group,
        d.online_state ? d.online_state.toLowerCase() === 'online' : null,
        d.last_seen ?? null,
      );
    }
    // 2. Groupes d'appareils gérés du même nom.
    for (const g of managedGroups) {
      found.add(g.name);
      for (const d of g.devices) {
        consider([d.teamviewerId], d.name, g.name, typeof d.isOnline === 'boolean' ? d.isOnline : null, d.lastSeen ?? null);
      }
    }
    toDeploy.sort((a, b) => Number(b.online) - Number(a.online) || a.alias.localeCompare(b.alias, 'fr'));
    if (groupsError && managedGroupsError) {
      warnings.push(
        `groupes non lus (${groupsError} ; ${managedGroupsError}) : ajouter au jeton le droit de lecture « Gestion des groupes » ou « Groupes d'appareils »`,
      );
    } else if (!found.size) {
      warnings.push(`aucun groupe TeamViewer nommé ${wanted.join(' ou ')} : renseigner TEAMVIEWER_GROUPS dans le .env`);
    }

    Object.assign(tvStatus, {
      groups: { wanted, found: [...found] },
      toDeploy,
      lastSyncAt: new Date().toISOString(),
      error: null,
      devices: aliases.size,
      matched,
      updated,
      unmatched,
      removed: [...tvStatus.removed.filter((x) => !removed.includes(x)), ...removed].slice(-20),
      pendingRemoval,
      // Le droit manquant ne gêne que si des serveurs restent introuvables.
      warning: [unmatched.length ? managedWarning : null, ...warnings].filter(Boolean).join(' — ') || null,
    });
  } catch (e) {
    tvStatus.lastSyncAt = new Date().toISOString();
    tvStatus.error = (e as Error).message;
    log(`Synchronisation TeamViewer : ${tvStatus.error}`);
  }
  return tvStatus;
}
