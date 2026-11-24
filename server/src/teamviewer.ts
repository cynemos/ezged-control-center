import { config } from './config.js';
import type { Db } from './db.js';

// Synchronisation avec la liste « Ordinateurs et contacts » du compte TeamViewer (API web, jeton de
// script en lecture seule). Chaque serveur est retrouvé par l'ID TeamViewer que remonte l'agent ;
// son nom TeamViewer remplit le nom affiché et le client des fiches encore vides, sans jamais
// écraser une saisie faite dans la console.

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

export async function syncTeamViewer(db: Db, log: (msg: string) => void): Promise<TeamViewerStatus> {
  tvStatus.enabled = Boolean(config.teamviewerApiToken);
  if (!tvStatus.enabled) return tvStatus;
  try {
    const aliases = new Map<string, string>();
    const add = (id: unknown, alias: unknown) => {
      const k = digits(id);
      const a = String(alias ?? '').trim();
      if (k && a && !aliases.has(k)) aliases.set(k, a.slice(0, 200));
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
      add(d.remotecontrol_id, d.alias);
      add(d.teamviewer_id, d.alias);
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
    for (const path of ['/managed/devices', '/managed/devices/company']) {
      try {
        for (const d of await managedDevices(path)) add(d.teamviewerId, d.name);
      } catch (e) {
        managedErrors.push((e as Error).message);
      }
    }
    const managedWarning = managedErrors.length
      ? `appareils gérés non lus (${managedErrors.join(' ; ')}) : ajouter au jeton le droit de lecture « Gestion des appareils »`
      : null;

    const rows = await db.query<{
      id: string;
      hostname: string;
      tv: string;
      display_name: string | null;
      client_id: number | null;
      client_name: string | null;
    }>(
      `SELECT s.id, s.hostname, s.snapshot->>'teamviewerId' AS tv, s.display_name, s.client_id, c.name AS client_name
         FROM servers s LEFT JOIN clients c ON c.id = s.client_id
        WHERE s.snapshot->>'teamviewerId' IS NOT NULL`,
    );
    let matched = 0;
    let updated = 0;
    const unmatched: string[] = [];
    for (const r of rows) {
      const alias = aliases.get(digits(r.tv));
      if (!alias) {
        unmatched.push(`${r.hostname} (${digits(r.tv)})`);
        continue;
      }
      matched++;
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
      if (!r.display_name || clientId !== null) {
        await db.query(
          `UPDATE servers SET display_name = COALESCE(display_name, $2),
                  client_id = CASE WHEN $4::boolean THEN COALESCE($3, client_id) ELSE COALESCE(client_id, $3) END
            WHERE id = $1`,
          [r.id, alias, clientId, badClient],
        );
        updated++;
      }
    }
    const orphans = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM clients c WHERE NOT EXISTS (SELECT 1 FROM servers s WHERE s.client_id = c.id)',
    );
    for (const o of orphans) if (isVersionOnly(o.name)) await db.query('DELETE FROM clients WHERE id = $1', [o.id]);

    // Agents à déployer : appareils des groupes suivis dont l'ID n'est remonté par aucun agent.
    const equipped = new Set(rows.map((r) => digits(r.tv)));
    const names = await db.query<{ id: string; name: string }>('SELECT id, COALESCE(display_name, hostname) AS name FROM servers');
    const byName = new Map(names.map((n) => [n.name.trim().toLowerCase(), n.name]));
    const ignored = new Set((await db.query<{ tv_id: string }>('SELECT tv_id FROM tv_ignored')).map((r) => r.tv_id));
    const wanted = config.teamviewerGroups;
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
    // 2. Groupes d'appareils gérés (droit « Groupes d'appareils »), du même nom.
    let managedGroupsError: string | null = null;
    try {
      const groups = await managedDevices<{ id?: string; name?: string }>('/managed/groups');
      for (const g of groups) {
        if (!g.id || !g.name || !wanted.includes(g.name.toLowerCase())) continue;
        found.add(g.name);
        for (const d of await managedDevices(`/managed/groups/${encodeURIComponent(g.id)}/devices`)) {
          consider([d.teamviewerId], d.name, g.name, typeof d.isOnline === 'boolean' ? d.isOnline : null, d.lastSeen ?? null);
        }
      }
    } catch (e) {
      managedGroupsError = (e as Error).message;
    }
    toDeploy.sort((a, b) => Number(b.online) - Number(a.online) || a.alias.localeCompare(b.alias, 'fr'));
    if (groupsError && managedGroupsError) {
      warnings.push(
        `groupes non lus (${groupsError} ; ${managedGroupsError}) : ajouter au jeton le droit de lecture « Gestion des groupes » ou « Groupes d'appareils »`,
      );
    } else if (!found.size) {
      warnings.push(`aucun groupe TeamViewer nommé ${wanted.join(' ou ')} : renseigner TEAMVIEWER_GROUPS dans le .env`);
    }
    const groupWarning = warnings.length ? `agents à déployer : ${warnings.join(' ; ')}` : null;

    Object.assign(tvStatus, {
      groups: { wanted, found: [...found] },
      toDeploy,
      lastSyncAt: new Date().toISOString(),
      error: null,
      devices: aliases.size,
      matched,
      updated,
      unmatched,
      // Le droit manquant ne gêne que si des serveurs restent introuvables.
      warning: [unmatched.length ? managedWarning : null, groupWarning].filter(Boolean).join(' — ') || null,
    });
  } catch (e) {
    tvStatus.lastSyncAt = new Date().toISOString();
    tvStatus.error = (e as Error).message;
    log(`Synchronisation TeamViewer : ${tvStatus.error}`);
  }
  return tvStatus;
}
