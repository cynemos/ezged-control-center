import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { evaluate, syncAlerts } from '../alerts.js';
import { newToken, safeEqual, sha256 } from '../auth.js';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { bootstrapScript, consumeDeployToken, deployTokenValid } from '../deploy.js';
import { normalizeSnapshot } from '../normalize.js';
import { decryptKey, SSL_AGENT_MIN, SSL_MAX_ATTEMPTS, SSL_STALE_MS, versionAtLeast } from '../ssl.js';
import { requestTeamViewerSync } from '../teamviewer.js';
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
export async function agentScript() {
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

// Tendance de remplissage disque : pente de disk_max sur 7 jours (régression linéaire), recalculée
// au plus tous les quarts d'heure par serveur. Il faut au moins 2 jours d'historique.
const trendCache = new Map<string, { at: number; days: number | null }>();
async function diskTrend(db: Db, serverId: string): Promise<number | null> {
  const cached = trendCache.get(serverId);
  if (cached && Date.now() - cached.at < 15 * 60_000) return cached.days;
  const [r] = await db.query<{ slope: number | null; span_h: number | null; last: number | null }>(
    `SELECT regr_slope(disk_max, extract(epoch FROM ts)) AS slope,
            extract(epoch FROM max(ts) - min(ts)) / 3600 AS span_h,
            (array_agg(disk_max ORDER BY ts DESC))[1] AS last
       FROM metrics WHERE server_id = $1 AND ts > now() - interval '7 days' AND disk_max IS NOT NULL`,
    [serverId],
  );
  let days: number | null = null;
  const slope = r?.slope === null || r?.slope === undefined ? null : Number(r.slope); // points de % par seconde
  if (slope !== null && slope > 0 && Number(r?.span_h ?? 0) >= 48 && r?.last !== null && r?.last !== undefined) {
    days = (100 - Number(r.last)) / (slope * 86_400);
    if (!Number.isFinite(days) || days > 3650) days = null;
  }
  trendCache.set(serverId, { at: Date.now(), days });
  await db.query('UPDATE servers SET disk_full_days = $2 WHERE id = $1', [serverId, days]);
  return days;
}

function digits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '').slice(0, 20);
}

function clampPct(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

export function agentRoutes(app: FastifyInstance, db: Db) {
  async function authAgent(req: FastifyRequest): Promise<{ id: string; inventory: Inventory | null; tv: string | null } | null> {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) return null;
    const [row] = await db.query<{ id: string; inventory: Inventory | null; tv: string | null }>(
      "SELECT id, inventory, snapshot->>'teamviewerId' AS tv FROM servers WHERE token_hash = $1",
      [sha256(token)],
    );
    return row ?? null;
  }

  // Enregistrement : l'installeur échange la clé d'enrôlement, ou un jeton de déploiement,
  // contre un jeton propre au serveur.
  // Si la machine est déjà connue (même MachineGuid et même ID TeamViewer), sa fiche et son historique
  // sont conservés et seul le jeton est renouvelé : l'ancien jeton cesse de fonctionner.
  app.post<{
    Body: { enrollKey?: string; deployToken?: string; hostname?: string; rustdeskId?: string; machineId?: string; teamviewerId?: string };
  }>(
    '/api/agent/enroll',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { enrollKey = '', deployToken = '', hostname = '', rustdeskId, machineId, teamviewerId } = req.body ?? {};
      const name = String(hostname).trim().slice(0, 100);
      if (!name) return reply.code(400).send({ error: 'hostname manquant' });
      let deployId: string | null = null;
      if (deployToken) {
        deployId = await consumeDeployToken(db, String(deployToken));
        if (!deployId) return reply.code(403).send({ error: 'Jeton de déploiement invalide, expiré, révoqué ou épuisé' });
      } else if (!safeEqual(enrollKey, config.enrollKey)) {
        return reply.code(403).send({ error: "Clé d'enrôlement invalide" });
      }
      const machine = machineId ? String(machineId).trim().toLowerCase().slice(0, 64) || null : null;
      const rustdesk = rustdeskId ? String(rustdeskId).slice(0, 50) : null;
      const tv = digits(teamviewerId);

      const token = newToken();
      // Fiche existante de la même machine (MachineGuid). Deux serveurs clonés depuis la même image
      // partagent ce MachineGuid : l'ID TeamViewer les départage, un clone reçoit sa propre fiche
      // (machine_id « guid|idTeamViewer ») au lieu de reprendre celle de l'autre.
      let machineKey = machine;
      if (machine) {
        const known = await db.query<{ id: string; machine_id: string; tv: string | null }>(
          `SELECT id, machine_id, snapshot->>'teamviewerId' AS tv FROM servers
            WHERE machine_id = $1 OR machine_id LIKE $1 || '|%'`,
          [machine],
        );
        const same = tv
          ? (known.find((k) => digits(k.tv) === tv || k.machine_id === `${machine}|${tv}`) ??
            known.find((k) => k.machine_id === machine && !digits(k.tv)))
          : known.find((k) => k.machine_id === machine);
        if (same) {
          await db.query(
            `UPDATE servers SET token_hash = $2, hostname = $3, rustdesk_id = COALESCE($4, rustdesk_id),
                    deploy_token_id = COALESCE($5, deploy_token_id)
              WHERE id = $1`,
            [same.id, sha256(token), name, rustdesk, deployId],
          );
          req.log.info({ id: same.id, hostname: name }, 'Agent réenrôlé, fiche existante conservée');
          return { serverId: same.id, token, reused: true };
        }
        if (known.length && tv) {
          machineKey = `${machine}|${tv}`;
          req.log.warn({ hostname: name, teamviewerId: tv, others: known.map((k) => k.id) }, 'MachineGuid déjà connu (serveur cloné) : nouvelle fiche');
        } else if (known.length) {
          machineKey = null;
          req.log.warn({ hostname: name, others: known.map((k) => k.id) }, 'MachineGuid déjà connu, sans ID TeamViewer : nouvelle fiche');
        }
      }

      const id = randomUUID();
      await db.query(
        'INSERT INTO servers (id, hostname, token_hash, rustdesk_id, machine_id, deploy_token_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, name, sha256(token), rustdesk, machineKey, deployId],
      );
      req.log.info({ id, hostname: name, deployToken: deployId }, 'Agent enrôlé');
      return { serverId: id, token, reused: false };
    },
  );

  // Script d'installation pour un déploiement par outil tiers : le jeton est passé en en-tête
  // (X-Deploy-Token) pour ne pas finir dans les journaux d'accès. Il n'est consommé qu'à l'enregistrement.
  app.get('/api/agent/bootstrap', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const token = String(req.headers['x-deploy-token'] ?? '').trim();
    if (!(await deployTokenValid(db, token))) {
      return reply.code(403).type('text/plain').send("throw 'Jeton de deploiement EzGed ControlCenter invalide, expire, revoque ou epuise'");
    }
    const script = await bootstrapScript(token);
    if (!script) return reply.code(500).type('text/plain').send("throw 'Scripts agent introuvables sur la console'");
    return reply.type('text/plain; charset=utf-8').header('cache-control', 'no-store').send(script);
  });

  // Contrôle du jeton par l'installeur : un jeton refusé (fiche supprimée, ou reprise par un autre
  // serveur) déclenche un nouvel enregistrement au lieu d'un agent qui échoue en silence.
  app.get('/api/agent/whoami', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const server = await authAgent(req);
    if (!server) return reply.code(401).send({ error: 'Jeton invalide' });
    return { serverId: server.id };
  });

  app.post<{ Body: AgentReport }>('/api/agent/report', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const server = await authAgent(req);
    if (!server) return reply.code(401).send({ error: 'Jeton invalide' });

    const body = req.body ?? {};
    const { inventory, ...rawSnapshot } = body;
    const snapshot = normalizeSnapshot(rawSnapshot);
    const m = snapshot.metrics ?? {};
    const diskMax = Math.max(0, ...(m.disks ?? []).map((d) => d.usedPct ?? 0));
    const queueTotal = Object.values(snapshot.queues ?? {}).reduce((a, q) => a + (q.count ?? 0), 0);

    await db.query(
      `UPDATE servers SET last_seen = now(), last_ip = $2, agent_version = $3, hostname = COALESCE($4, hostname), snapshot = $5
        WHERE id = $1`,
      [server.id, req.ip, snapshot.agentVersion ?? null, snapshot.hostname ?? null, JSON.stringify(snapshot)],
    );

    // Nouvel agent, ou ID TeamViewer changé : synchronisation TeamViewer sans attendre le quart
    // d'heure, pour le nom et le client de la fiche et la liste des agents à déployer.
    const tvId = digits(snapshot.teamviewerId);
    if (tvId && tvId !== digits(server.tv)) requestTeamViewerSync(db, (msg) => req.log.warn(msg));

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
    const diskFullDays = await diskTrend(db, server.id);
    const findings = evaluate(snapshot, inv?.inventory ?? null, recentCpu, diskFullDays);
    await syncAlerts(db, server.id, findings, 'report', (msg) => req.log.warn(msg));

    const script = config.agentAutoUpdate ? await agentScript() : null;
    const agentUpdate =
      script && script.version !== snapshot.agentVersion ? { version: script.version, sha256: script.sha256 } : undefined;
    const sslDeploy = versionAtLeast(snapshot.agentVersion, SSL_AGENT_MIN) ? await sslOffer(server.id) : undefined;
    return { ok: true, inventoryIntervalMin: INVENTORY_INTERVAL_MIN, agentUpdate, sslDeploy };
  });

  // Remplacement du certificat SSL demandé pour ce serveur : proposé tant qu'il est en attente, ou
  // resté sans résultat (agent interrompu), dans la limite de SSL_MAX_ATTEMPTS remises des fichiers.
  async function sslOffer(serverId: string) {
    await db.query(
      `UPDATE ssl_jobs SET status = 'failed', updated_at = now(),
              message = 'Pas de résultat de l''agent après ${SSL_MAX_ATTEMPTS} tentatives'
        WHERE server_id = $1 AND status = 'running' AND attempts >= $2 AND updated_at < now() - make_interval(secs => $3)`,
      [serverId, SSL_MAX_ATTEMPTS, SSL_STALE_MS / 1000],
    );
    const [job] = await db.query<{ id: string; thumbprint: string; cn: string }>(
      `SELECT b.id, b.thumbprint, b.cn FROM ssl_jobs j JOIN ssl_bundles b ON b.id = j.bundle_id
        WHERE j.server_id = $1 AND b.key_enc IS NOT NULL AND b.not_before <= now() AND j.attempts < $2
          AND (j.status = 'pending' OR (j.status = 'running' AND j.updated_at < now() - make_interval(secs => $3)))
        ORDER BY j.requested_at LIMIT 1`,
      [serverId, SSL_MAX_ATTEMPTS, SSL_STALE_MS / 1000],
    );
    return job ? { id: job.id, thumbprint: job.thumbprint, cn: job.cn } : undefined;
  }

  // Fichiers du certificat remis à l'agent du serveur concerné, uniquement pour un remplacement demandé.
  app.get<{ Params: { id: string } }>(
    '/api/agent/ssl/:id',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const server = await authAgent(req);
      if (!server) return reply.code(401).send({ error: 'Jeton invalide' });
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: 'Introuvable' });
      const offer = await sslOffer(server.id);
      if (!offer || offer.id !== req.params.id) return reply.code(404).send({ error: 'Aucun remplacement demandé' });
      const [b] = await db.query<{ cert_pem: string; chain_pem: string; key_enc: string; thumbprint: string; cn: string }>(
        'SELECT cert_pem, chain_pem, key_enc, thumbprint, cn FROM ssl_bundles WHERE id = $1',
        [offer.id],
      );
      let key: string;
      try {
        key = decryptKey(b.key_enc);
      } catch {
        await db.query(
          `UPDATE ssl_jobs SET status = 'failed', updated_at = now(),
                  message = 'Clé privée illisible dans la console (SESSION_SECRET changé ?) : redéposer les fichiers'
            WHERE bundle_id = $1 AND server_id = $2`,
          [offer.id, server.id],
        );
        return reply.code(410).send({ error: 'Clé privée illisible' });
      }
      await db.query(
        "UPDATE ssl_jobs SET status = 'running', attempts = attempts + 1, updated_at = now(), message = NULL WHERE bundle_id = $1 AND server_id = $2",
        [offer.id, server.id],
      );
      req.log.info({ serverId: server.id, bundle: offer.id }, 'Certificat SSL remis à l’agent');
      return reply.header('cache-control', 'no-store').send({ cert: b.cert_pem, chain: b.chain_pem, key, thumbprint: b.thumbprint, cn: b.cn });
    },
  );

  // Résultat du remplacement, envoyé par l'agent juste après l'opération.
  app.post<{ Params: { id: string }; Body: { ok?: boolean; message?: string } }>(
    '/api/agent/ssl/:id/result',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const server = await authAgent(req);
      if (!server) return reply.code(401).send({ error: 'Jeton invalide' });
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: 'Introuvable' });
      const ok = req.body?.ok === true;
      const message = String(req.body?.message ?? '').slice(0, 1000) || null;
      const rows = await db.query(
        `UPDATE ssl_jobs SET status = $3, message = $4, updated_at = now()
          WHERE bundle_id = $1 AND server_id = $2 AND status = 'running' RETURNING server_id`,
        [req.params.id, server.id, ok ? 'ok' : 'failed', message],
      );
      if (!rows.length) return reply.code(404).send({ error: 'Aucun remplacement en cours' });
      if (ok) req.log.info({ serverId: server.id }, `Certificat SSL remplacé : ${message ?? ''}`);
      else req.log.warn({ serverId: server.id }, `Échec du remplacement du certificat SSL : ${message ?? ''}`);
      return { ok: true };
    },
  );

  // Téléchargement du script agent par un agent authentifié (mise à jour automatique).
  app.get('/api/agent/script', async (req, reply) => {
    const server = await authAgent(req);
    if (!server) return reply.code(401).send({ error: 'Jeton invalide' });
    const script = config.agentAutoUpdate ? await agentScript() : null;
    if (!script) return reply.code(404).send({ error: 'Mise à jour automatique désactivée' });
    return reply.type('application/octet-stream').header('cache-control', 'no-store').send(script.body);
  });
}
