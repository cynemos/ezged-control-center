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
};

/**
 * Client déduit du nom TeamViewer : sans les numéros de version en tête ni le dernier segment
 * (VM, new...). « 15 - 3.4 - C3SM CLAIRA - VM TJP » donne « C3SM CLAIRA » ;
 * « 4.0 - MAIRIE DE GRAISSESSAC » donne « MAIRIE DE GRAISSESSAC ».
 */
export function clientFromAlias(alias: string): string | null {
  const parts = alias
    .split(/\s+-\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  while (parts.length > 1 && /^[\d.]+$/.test(parts[0])) parts.shift();
  if (parts.length > 1) parts.pop();
  const name = parts.join(' - ').trim();
  return name && !/^[\d.]+$/.test(name) ? name.slice(0, 100) : null;
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

/** Appareils gérés (Remote Management, affectation au compte), paginés. */
async function managedDevices(path: string): Promise<{ teamviewerId?: number | string; name?: string }[]> {
  const out: { teamviewerId?: number | string; name?: string }[] = [];
  let token = '';
  for (let page = 0; page < 50; page++) {
    const body = await tvGet<{ nextPaginationToken?: string; resources?: { teamviewerId?: number; name?: string }[] }>(
      path + (token ? `?paginationToken=${encodeURIComponent(token)}` : ''),
    );
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
    const body = await tvGet<{ devices?: { remotecontrol_id?: string; teamviewer_id?: number; alias?: string }[] }>('/devices');
    for (const d of body.devices ?? []) {
      add(d.remotecontrol_id, d.alias);
      add(d.teamviewer_id, d.alias);
    }
    // Appareils gérés (personnels puis de l'entreprise) : facultatifs, ils demandent le droit de
    // lecture « Gestion des appareils » sur le jeton.
    const warnings: string[] = [];
    for (const path of ['/managed/devices', '/managed/devices/company']) {
      try {
        for (const d of await managedDevices(path)) add(d.teamviewerId, d.name);
      } catch (e) {
        warnings.push((e as Error).message);
      }
    }
    tvStatus.warning = warnings.length
      ? `appareils gérés non lus (${warnings.join(' ; ')}) : ajouter au jeton le droit de lecture « Gestion des appareils »`
      : null;

    const rows = await db.query<{ id: string; hostname: string; tv: string; display_name: string | null; client_id: number | null }>(
      `SELECT id, hostname, snapshot->>'teamviewerId' AS tv, display_name, client_id
         FROM servers WHERE snapshot->>'teamviewerId' IS NOT NULL`,
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
      const client = r.client_id === null ? clientFromAlias(alias) : null;
      if (client) {
        const [c] = await db.query<{ id: number }>(
          'INSERT INTO clients (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
          [client],
        );
        clientId = c.id;
      }
      if (!r.display_name || clientId !== null) {
        await db.query(
          `UPDATE servers SET display_name = COALESCE(display_name, $2), client_id = COALESCE(client_id, $3) WHERE id = $1`,
          [r.id, alias, clientId],
        );
        updated++;
      }
    }
    Object.assign(tvStatus, { lastSyncAt: new Date().toISOString(), error: null, devices: aliases.size, matched, updated, unmatched });
  } catch (e) {
    tvStatus.lastSyncAt = new Date().toISOString();
    tvStatus.error = (e as Error).message;
    log(`Synchronisation TeamViewer : ${tvStatus.error}`);
  }
  return tvStatus;
}
