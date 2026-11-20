import { config } from './config.js';
import type { Db } from './db.js';

// Synchronisation avec la liste « Ordinateurs et contacts » du compte TeamViewer (API web, jeton de
// script en lecture seule). Chaque serveur est retrouvé par l'ID TeamViewer que remonte l'agent ;
// son nom TeamViewer remplit le nom affiché et le client des fiches encore vides, sans jamais
// écraser une saisie faite dans la console.

const DEVICES_URL = 'https://webapi.teamviewer.com/api/v1/devices';

export interface TeamViewerStatus {
  enabled: boolean;
  lastSyncAt: string | null;
  error: string | null;
  devices: number;
  matched: number;
  updated: number;
}

export const tvStatus: TeamViewerStatus = {
  enabled: false,
  lastSyncAt: null,
  error: null,
  devices: 0,
  matched: 0,
  updated: 0,
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

export async function syncTeamViewer(db: Db, log: (msg: string) => void): Promise<TeamViewerStatus> {
  tvStatus.enabled = Boolean(config.teamviewerApiToken);
  if (!tvStatus.enabled) return tvStatus;
  try {
    const res = await fetch(DEVICES_URL, {
      headers: { authorization: `Bearer ${config.teamviewerApiToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401 || res.status === 403
          ? `jeton refusé par TeamViewer (HTTP ${res.status}) : vérifier TEAMVIEWER_API_TOKEN et le droit de lecture « Ordinateurs et contacts »`
          : `API TeamViewer : HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as { devices?: { remotecontrol_id?: string; alias?: string }[] };
    const aliases = new Map<string, string>();
    for (const d of body.devices ?? []) {
      const id = digits(d.remotecontrol_id);
      const alias = String(d.alias ?? '').trim();
      if (id && alias) aliases.set(id, alias.slice(0, 200));
    }

    const rows = await db.query<{ id: string; tv: string; display_name: string | null; client_id: number | null }>(
      `SELECT id, snapshot->>'teamviewerId' AS tv, display_name, client_id
         FROM servers WHERE snapshot->>'teamviewerId' IS NOT NULL`,
    );
    let matched = 0;
    let updated = 0;
    for (const r of rows) {
      const alias = aliases.get(digits(r.tv));
      if (!alias) continue;
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
    Object.assign(tvStatus, { lastSyncAt: new Date().toISOString(), error: null, devices: aliases.size, matched, updated });
  } catch (e) {
    tvStatus.lastSyncAt = new Date().toISOString();
    tvStatus.error = (e as Error).message;
    log(`Synchronisation TeamViewer : ${tvStatus.error}`);
  }
  return tvStatus;
}
