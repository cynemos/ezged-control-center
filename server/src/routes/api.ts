import type { FastifyInstance } from 'fastify';
import { createSession, requireUser, safeEqual, SESSION_COOKIE, verifyTotp } from '../auth.js';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { normalizeSnapshot } from '../normalize.js';
import type { Inventory, Snapshot } from '../types.js';

interface ServerRow {
  id: string;
  hostname: string;
  display_name: string | null;
  client_id: number | null;
  client_name: string | null;
  rustdesk_id: string | null;
  notes: string | null;
  enrolled_at: Date;
  last_seen: Date | null;
  last_ip: string | null;
  agent_version: string | null;
  snapshot: Snapshot | null;
  inventory: Inventory | null;
  inventory_at: Date | null;
  crit: number;
  warn: number;
  open_rules: { rule: string; severity: 'warning' | 'critical' }[] | null;
  disk_full_days: number | null;
}

type Light = 'ok' | 'warning' | 'critical' | 'na';

// Voyants de santé : chaque alerte ouverte allume la catégorie de sa règle.
// Ordre d'affichage = ordre de ce tableau.
const HEALTH_GROUPS: { key: string; label: string; prefixes: string[] }[] = [
  { key: 'agent', label: 'Agent', prefixes: ['offline', 'agent:'] },
  { key: 'system', label: 'Système', prefixes: ['cpu', 'mem', 'disk:', 'diskfull'] },
  { key: 'hardware', label: 'Matériel', prefixes: ['event:', 'smart:'] },
  { key: 'services', label: 'Services', prefixes: ['service:', 'restart:', 'db', 'log:'] },
  { key: 'web', label: 'Web', prefixes: ['http', 'web', 'apache:'] },
  { key: 'queues', label: 'Files', prefixes: ['queue:'] },
  { key: 'dump', label: 'Dump', prefixes: ['backup'] },
  { key: 'veeam', label: 'Veeam', prefixes: ['veeam:'] },
  { key: 'certs', label: 'SSL', prefixes: ['cert:'] },
];

function matches(rule: string, prefix: string): boolean {
  return prefix.endsWith(':') ? rule.startsWith(prefix) : rule === prefix || rule.startsWith(`${prefix}:`);
}

function health(r: ServerRow): { key: string; label: string; state: Light }[] {
  const rules = r.open_rules ?? [];
  return HEALTH_GROUPS.map((g) => {
    const hits = rules.filter((a) => g.prefixes.some((p) => matches(a.rule, p)));
    let state: Light = hits.some((a) => a.severity === 'critical') ? 'critical' : hits.length ? 'warning' : 'ok';
    // Sans donnée pour la catégorie : voyant éteint plutôt que vert trompeur.
    if (state === 'ok') {
      if (!r.last_seen) state = 'na';
      else if (g.key === 'veeam' && !r.snapshot?.veeam) state = 'na';
      else if (g.key === 'dump' && !r.snapshot?.backup) state = 'na';
      else if (g.key === 'certs' && !r.inventory?.certificates?.length) state = 'na';
      else if (g.key === 'hardware' && !r.snapshot?.events) state = 'na';
    }
    return { key: g.key, label: g.label, state };
  });
}

const SERVER_SELECT = `
  SELECT s.id, s.hostname, s.display_name, s.client_id, c.name AS client_name, s.rustdesk_id, s.notes,
         s.enrolled_at, s.last_seen, s.last_ip, s.agent_version, s.snapshot, s.inventory, s.inventory_at, s.disk_full_days,
         (SELECT count(*)::int FROM alerts a WHERE a.server_id = s.id AND a.closed_at IS NULL AND a.severity = 'critical') AS crit,
         (SELECT count(*)::int FROM alerts a WHERE a.server_id = s.id AND a.closed_at IS NULL AND a.severity = 'warning') AS warn,
         (SELECT json_agg(json_build_object('rule', a.rule, 'severity', a.severity)) FROM alerts a
           WHERE a.server_id = s.id AND a.closed_at IS NULL) AS open_rules
    FROM servers s LEFT JOIN clients c ON c.id = s.client_id`;

function status(r: ServerRow): 'pending' | 'offline' | 'critical' | 'warning' | 'ok' {
  if (!r.last_seen) return 'pending';
  if (Date.now() - new Date(r.last_seen).getTime() > config.offlineMinutes * 60_000) return 'offline';
  if (r.crit > 0) return 'critical';
  if (r.warn > 0) return 'warning';
  return 'ok';
}

function summary(r: ServerRow) {
  const m = r.snapshot?.metrics ?? {};
  const disks = m.disks ?? [];
  return {
    id: r.id,
    name: r.display_name || r.hostname,
    hostname: r.hostname,
    client: r.client_name,
    status: status(r),
    lastSeen: r.last_seen,
    cpu: m.cpu ?? null,
    mem: m.memUsedPct ?? null,
    diskMax: disks.length ? Math.max(...disks.map((d) => d.usedPct)) : null,
    backupAgeHours: r.snapshot?.backup?.ageHours ?? null,
    httpMs: r.snapshot?.http?.ms ?? null,
    pendingReboot: r.snapshot?.pendingReboot ?? false,
    versions: {
      ezged: r.inventory?.versions?.ezged ?? null,
      apache: r.inventory?.versions?.apache ?? null,
      php: r.inventory?.versions?.php ?? null,
      mariadb: r.inventory?.versions?.mariadb ?? null,
      windows: r.inventory?.os
        ? `${(r.inventory.os.caption ?? '').replace(/^Microsoft\s+/i, '')} (${r.inventory.os.build ?? '?'})`.trim()
        : null,
    },
    windowsUpdatesPending: r.inventory?.windowsUpdates?.pending ?? null,
    alerts: { critical: r.crit, warning: r.warn },
    health: health(r),
    veeamAgeHours: r.snapshot?.veeam?.okAgeHours ?? null,
    uptimeHours: m.uptimeHours ?? null,
    diskFullDays: r.disk_full_days === null ? null : Math.round(r.disk_full_days),
    rustdeskId: r.rustdesk_id,
    agentVersion: r.agent_version,
  };
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

export function apiRoutes(app: FastifyInstance, db: Db) {
  // ---- Authentification ----
  app.post<{ Body: { user?: string; password?: string; totp?: string } }>(
    '/api/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { user = '', password = '', totp = '' } = req.body ?? {};
      const okUser = safeEqual(user, config.adminUser);
      const okPass = safeEqual(password, config.adminPassword);
      const okTotp = !config.adminTotpSecret || verifyTotp(config.adminTotpSecret, totp.trim());
      if (!(okUser && okPass && okTotp)) {
        req.log.warn({ user }, 'Échec de connexion');
        return reply.code(401).send({ error: 'Identifiants invalides' });
      }
      reply.setCookie(SESSION_COOKIE, createSession(user), {
        path: config.basePath || '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: config.production,
        maxAge: config.sessionHours * 3600,
      });
      return { ok: true };
    },
  );

  app.get('/api/auth-info', async () => ({ totp: Boolean(config.adminTotpSecret) }));

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: config.basePath || '/' });
    return { ok: true };
  });

  // Toutes les routes ci-dessous exigent une session.
  app.register(async (priv) => {
    priv.addHook('preHandler', requireUser);

    priv.get('/api/me', async () => ({ user: config.adminUser }));

    priv.get('/api/servers', async () => {
      const rows = await db.query<ServerRow>(`${SERVER_SELECT} ORDER BY c.name NULLS LAST, COALESCE(s.display_name, s.hostname)`);
      return rows.map(summary);
    });

    priv.get<{ Params: { id: string } }>('/api/servers/:id', async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Introuvable' });
      const [row] = await db.query<ServerRow>(`${SERVER_SELECT} WHERE s.id = $1`, [req.params.id]);
      if (!row) return reply.code(404).send({ error: 'Introuvable' });
      const alerts = await db.query(
        `SELECT id, rule, severity, message, opened_at, closed_at, acked FROM alerts
          WHERE server_id = $1 ORDER BY closed_at IS NOT NULL, opened_at DESC LIMIT 50`,
        [row.id],
      );
      const versionHistory = await db.query(
        'SELECT component, old_version, new_version, changed_at FROM version_history WHERE server_id = $1 ORDER BY changed_at DESC LIMIT 50',
        [row.id],
      );
      return {
        ...summary(row),
        notes: row.notes,
        clientId: row.client_id,
        enrolledAt: row.enrolled_at,
        lastIp: row.last_ip,
        inventoryAt: row.inventory_at,
        snapshot: normalizeSnapshot(row.snapshot),
        inventory: row.inventory,
        alertList: alerts,
        versionHistory,
      };
    });

    priv.get<{ Params: { id: string }; Querystring: { range?: string } }>('/api/servers/:id/metrics', async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Introuvable' });
      const range = req.query.range ?? '24h';
      if (range === '24h') {
        return db.query(
          `SELECT ts, cpu, mem, disk_max, http_ms, queue_total FROM metrics
            WHERE server_id = $1 AND ts > now() - interval '24 hours' ORDER BY ts`,
          [req.params.id],
        );
      }
      const days = range === '30d' ? 30 : 7;
      return db.query(
        `SELECT date_trunc('hour', ts) AS ts, avg(cpu)::real AS cpu, avg(mem)::real AS mem, max(disk_max)::real AS disk_max,
                avg(http_ms)::int AS http_ms, max(queue_total)::int AS queue_total
           FROM metrics WHERE server_id = $1 AND ts > now() - ($2 || ' days')::interval
          GROUP BY 1 ORDER BY 1`,
        [req.params.id, String(days)],
      );
    });

    priv.patch<{ Params: { id: string }; Body: { displayName?: string; clientName?: string; rustdeskId?: string; notes?: string } }>(
      '/api/servers/:id',
      async (req, reply) => {
        if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Introuvable' });
        const b = req.body ?? {};
        const clean = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

        let clientId: number | null | undefined;
        if (b.clientName !== undefined) {
          const name = clean(b.clientName, 100);
          if (name) {
            const [c] = await db.query<{ id: number }>(
              'INSERT INTO clients (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
              [name],
            );
            clientId = c.id;
          } else clientId = null;
        }
        await db.query(
          `UPDATE servers SET
             display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
             client_id    = CASE WHEN $4::boolean THEN $5::int ELSE client_id END,
             rustdesk_id  = CASE WHEN $6::boolean THEN $7 ELSE rustdesk_id END,
             notes        = CASE WHEN $8::boolean THEN $9 ELSE notes END
           WHERE id = $1`,
          [
            req.params.id,
            b.displayName !== undefined,
            clean(b.displayName, 100),
            clientId !== undefined,
            clientId ?? null,
            b.rustdeskId !== undefined,
            clean(b.rustdeskId, 50),
            b.notes !== undefined,
            clean(b.notes, 4000),
          ],
        );
        return { ok: true };
      },
    );

    priv.delete<{ Params: { id: string } }>('/api/servers/:id', async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Introuvable' });
      await db.query('DELETE FROM servers WHERE id = $1', [req.params.id]);
      return { ok: true };
    });

    priv.get('/api/clients', async () => db.query('SELECT id, name FROM clients ORDER BY name'));

    priv.get<{ Querystring: { state?: string } }>('/api/alerts', async (req) => {
      const open = req.query.state !== 'all';
      return db.query(
        `SELECT a.id, a.server_id, a.rule, a.severity, a.message, a.opened_at, a.closed_at, a.acked,
                COALESCE(s.display_name, s.hostname) AS server_name, c.name AS client_name
           FROM alerts a JOIN servers s ON s.id = a.server_id LEFT JOIN clients c ON c.id = s.client_id
          ${open ? 'WHERE a.closed_at IS NULL' : ''}
          ORDER BY a.closed_at IS NOT NULL, CASE a.severity WHEN 'critical' THEN 0 ELSE 1 END, a.opened_at DESC
          LIMIT 500`,
      );
    });

    priv.post<{ Params: { id: string } }>('/api/alerts/:id/ack', async (req) => {
      await db.query('UPDATE alerts SET acked = true WHERE id = $1', [Number(req.params.id)]);
      return { ok: true };
    });

    priv.get('/api/enroll-info', async () => ({ publicUrl: config.publicUrl, enrollKey: config.enrollKey }));
  });
}
