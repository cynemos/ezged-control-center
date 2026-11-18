import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { evaluate, syncAlerts } from '../alerts.js';
import { newToken, safeEqual, sha256 } from '../auth.js';
import { config } from '../config.js';
import type { Db } from '../db.js';
import type { AgentReport, Inventory } from '../types.js';

const INVENTORY_INTERVAL_MIN = 60;

function versionMap(inv: Inventory | null | undefined): Record<string, string> {
  const v = inv?.versions ?? {};
  const out: Record<string, string> = {};
  if (v.ezged) out.ezged = v.ezged;
  if (v.apache) out.apache = v.apache;
  if (v.php) out.php = v.php;
  if (v.mariadb) out.mariadb = v.mariadb;
  if (inv?.os?.build) out.windows = inv.os.build;
  return out;
}

// Script agent embarqué par la console : dépôt (../agent) en dev, InstallDir\agent dans le paquet Windows.
const AGENT_CANDIDATES = [config.agentScript, '../agent/ezged-cc-agent.ps1', '../../agent/ezged-cc-agent.ps1']
  .filter(Boolean)
  .map((p) => resolve(p));
let agentCache: { path: string; mtimeMs: number; body: Buffer; version: string; sha256: string } | null = null;

/** Script agent courant (relu si modifié sur disque), ou null s'il est introuvable. */
async function agentScript() {
  const path = AGENT_CANDIDATES.find((p) => existsSync(p));
  if (!path) return null;
  const { mtimeMs } = await stat(path);
  if (!agentCache || agentCache.path !== path || agentCache.mtimeMs !== mtimeMs) {
    const body = await readFile(path);
    const version = /^\$AgentVersion\s*=\s*'([0-9.]+)'/m.exec(body.toString('latin1'))?.[1] ?? '';
    agentCache = { path, mtimeMs, body, version, sha256: createHash('sha256').update(body).digest('hex') };
  }
  return agentCache.version ? agentCache : null;
}

function clampPct(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

export function agentRoutes(app: FastifyInstance, db: Db) {
  async function authAgent(req: FastifyRequest): Promise<{ id: string; inventory: Inventory | null } | null> {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) return null;
    const [row] = await db.query<{ id: string; inventory: Inventory | null }>(
      'SELECT id, inventory FROM servers WHERE token_hash = $1',
      [sha256(token)],
    );
    return row ?? null;
  }

  // Enregistrement : l'installeur échange la clé d'enrôlement contre un jeton propre au serveur.
  // Si la machine est déjà connue (même MachineGuid), sa fiche et son historique sont conservés
  // et seul le jeton est renouvelé : l'ancien jeton cesse de fonctionner.
  app.post<{ Body: { enrollKey?: string; hostname?: string; rustdeskId?: string; machineId?: string } }>(
    '/api/agent/enroll',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { enrollKey = '', hostname = '', rustdeskId, machineId } = req.body ?? {};
      if (!safeEqual(enrollKey, config.enrollKey)) return reply.code(403).send({ error: "Clé d'enrôlement invalide" });
      const name = String(hostname).trim().slice(0, 100);
      if (!name) return reply.code(400).send({ error: 'hostname manquant' });
      const machine = machineId ? String(machineId).trim().toLowerCase().slice(0, 64) || null : null;
      const rustdesk = rustdeskId ? String(rustdeskId).slice(0, 50) : null;

      const token = newToken();
      if (machine) {
        const [known] = await db.query<{ id: string }>(
          `UPDATE servers SET token_hash = $2, hostname = $3, rustdesk_id = COALESCE($4, rustdesk_id)
            WHERE machine_id = $1 RETURNING id`,
          [machine, sha256(token), name, rustdesk],
        );
        if (known) {
          req.log.info({ id: known.id, hostname: name }, 'Agent réenrôlé, fiche existante conservée');
          return { serverId: known.id, token, reused: true };
        }
      }

      const id = randomUUID();
      await db.query('INSERT INTO servers (id, hostname, token_hash, rustdesk_id, machine_id) VALUES ($1, $2, $3, $4, $5)', [
        id,
        name,
        sha256(token),
        rustdesk,
        machine,
      ]);
      req.log.info({ id, hostname: name }, 'Agent enrôlé');
      return { serverId: id, token, reused: false };
    },
  );

  app.post<{ Body: AgentReport }>('/api/agent/report', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const server = await authAgent(req);
    if (!server) return reply.code(401).send({ error: 'Jeton invalide' });

    const body = req.body ?? {};
    const { inventory, ...snapshot } = body;
    const m = snapshot.metrics ?? {};
    const diskMax = Math.max(0, ...(m.disks ?? []).map((d) => d.usedPct ?? 0));
    const queueTotal = Object.values(snapshot.queues ?? {}).reduce((a, q) => a + (q.count ?? 0), 0);

    await db.query(
      `UPDATE servers SET last_seen = now(), last_ip = $2, agent_version = $3, hostname = COALESCE($4, hostname), snapshot = $5
        WHERE id = $1`,
      [server.id, req.ip, snapshot.agentVersion ?? null, snapshot.hostname ?? null, JSON.stringify(snapshot)],
    );

    // Serveurs enrôlés avant l'ajout de machine_id : renseigné au premier rapport qui le fournit,
    // sauf si une autre fiche porte déjà cet identifiant.
    const machine = snapshot.machineId ? String(snapshot.machineId).trim().toLowerCase().slice(0, 64) : '';
    if (machine) {
      await db.query(
        `UPDATE servers SET machine_id = $2 WHERE id = $1 AND machine_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM servers WHERE machine_id = $2)`,
        [server.id, machine],
      );
    }

    if (inventory) {
      const before = versionMap(server.inventory);
      const after = versionMap(inventory);
      for (const [component, v] of Object.entries(after)) {
        if (server.inventory && before[component] !== v) {
          await db.query(
            'INSERT INTO version_history (server_id, component, old_version, new_version) VALUES ($1, $2, $3, $4)',
            [server.id, component, before[component] ?? null, v],
          );
        }
      }
      await db.query('UPDATE servers SET inventory = $2, inventory_at = now() WHERE id = $1', [server.id, JSON.stringify(inventory)]);
    }

    await db.query('INSERT INTO metrics (server_id, cpu, mem, disk_max, http_ms, queue_total) VALUES ($1, $2, $3, $4, $5, $6)', [
      server.id,
      clampPct(m.cpu),
      clampPct(m.memUsedPct),
      diskMax,
      snapshot.http?.ms ?? null,
      queueTotal,
    ]);

    const cpuRows = await db.query<{ cpu: number | null }>(
      'SELECT cpu FROM metrics WHERE server_id = $1 ORDER BY ts DESC LIMIT 5',
      [server.id],
    );
    const recentCpu = cpuRows.map((r) => r.cpu).filter((c): c is number => c !== null);
    const [inv] = await db.query<{ inventory: Inventory | null }>('SELECT inventory FROM servers WHERE id = $1', [server.id]);
    const findings = evaluate(snapshot, inv?.inventory ?? null, recentCpu);
    await syncAlerts(db, server.id, findings, 'report', (msg) => req.log.warn(msg));

    const script = config.agentAutoUpdate ? await agentScript() : null;
    const agentUpdate =
      script && script.version !== snapshot.agentVersion ? { version: script.version, sha256: script.sha256 } : undefined;
    return { ok: true, inventoryIntervalMin: INVENTORY_INTERVAL_MIN, agentUpdate };
  });

  // Téléchargement du script agent par un agent authentifié (mise à jour automatique).
  app.get('/api/agent/script', async (req, reply) => {
    const server = await authAgent(req);
    if (!server) return reply.code(401).send({ error: 'Jeton invalide' });
    const script = config.agentAutoUpdate ? await agentScript() : null;
    if (!script) return reply.code(404).send({ error: 'Mise à jour automatique désactivée' });
    return reply.type('application/octet-stream').header('cache-control', 'no-store').send(script.body);
  });
}
