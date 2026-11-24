import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { config } from './config.js';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS servers (
  id            UUID PRIMARY KEY,
  hostname      TEXT NOT NULL,
  display_name  TEXT,
  client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  rustdesk_id   TEXT,
  notes         TEXT,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ,
  last_ip       TEXT,
  agent_version TEXT,
  snapshot      JSONB,
  inventory     JSONB,
  inventory_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS metrics (
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  cpu         REAL,
  mem         REAL,
  disk_max    REAL,
  http_ms     INTEGER,
  queue_total INTEGER
);
CREATE INDEX IF NOT EXISTS metrics_server_ts ON metrics (server_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id         SERIAL PRIMARY KEY,
  server_id  UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  rule       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  message    TEXT NOT NULL,
  opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at  TIMESTAMPTZ,
  acked      BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open ON alerts (server_id, rule) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS version_history (
  id          SERIAL PRIMARY KEY,
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  component   TEXT NOT NULL,
  old_version TEXT,
  new_version TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identifiant Windows de la machine (MachineGuid) : un réenrôlement réutilise la même fiche.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS machine_id TEXT;
-- Jours avant disque plein (tendance de disk_max sur 7 jours), recalculé au plus tous les quarts d'heure.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS disk_full_days REAL;
CREATE UNIQUE INDEX IF NOT EXISTS servers_machine_id ON servers (machine_id) WHERE machine_id IS NOT NULL;

-- Jetons de déploiement (script TeamViewer, GPO...) : durée et nombre d'installations limités, révocables.
CREATE TABLE IF NOT EXISTS deploy_tokens (
  id          UUID PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  max_uses    INTEGER NOT NULL,
  uses        INTEGER NOT NULL DEFAULT 0,
  revoked_at  TIMESTAMPTZ
);
-- Jeton de déploiement ayant servi à enregistrer le serveur (traçabilité).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS deploy_token_id UUID;
-- Appareils TeamViewer écartés de la liste « Agents à déployer » (pas un serveur EzGED...).
CREATE TABLE IF NOT EXISTS tv_ignored (
  tv_id       TEXT PRIMARY KEY,
  alias       TEXT,
  ignored_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Origine du nom affiché : 'tv' (suit le nom TeamViewer), 'manual' (saisi dans la console, jamais
-- écrasé), NULL (inconnue, tranchée à la synchronisation suivante).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS name_source TEXT;
-- Listes TeamViewer où l'appareil a été vu (« devices,managed »), et depuis quand il n'y est plus :
-- la fiche est supprimée quand l'appareil a disparu de TeamViewer depuis une heure.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS tv_sources TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS tv_missing_since TIMESTAMPTZ;
`;

export async function openDb(): Promise<Db> {
  let db: Db;
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    db = {
      query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
      exec: async (sql) => {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  } else {
    mkdirSync(config.pgliteDir, { recursive: true });
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = new PGlite(config.pgliteDir);
    db = {
      query: async (sql, params) => (await lite.query(sql, params as any[])).rows as any[],
      exec: async (sql) => {
        await lite.exec(sql);
      },
      close: () => lite.close(),
    };
  }
  await db.exec(SCHEMA);
  return db;
}
