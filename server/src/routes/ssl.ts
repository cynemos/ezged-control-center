import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import {
  BUNDLE_SELECT,
  certUpToDate,
  commonName,
  currentBundle,
  encryptKey,
  matchingCerts,
  parseBundle,
  siteLinks,
  SSL_AGENT_MIN,
  versionAtLeast,
  type BundleRow,
} from '../ssl.js';
import type { Inventory } from '../types.js';

interface Row {
  id: string;
  name: string;
  client: string | null;
  agent_version: string | null;
  last_seen: Date | null;
  inventory: Inventory | null;
  inventory_at: Date | null;
}

interface JobRow {
  server_id: string;
  status: 'pending' | 'running' | 'ok' | 'failed';
  attempts: number;
  message: string | null;
  requested_at: Date;
  updated_at: Date;
}

const ONLINE_MS = 5 * 60_000;
/** Version de l'agent qui remonte les sites Apache (ServerName, redirections). */
const SITES_AGENT_MIN = '0.4.1';

function bundleView(b: BundleRow) {
  return {
    id: b.id,
    uploadedAt: b.uploaded_at,
    cn: b.cn,
    subject: b.subject,
    sans: b.sans ? b.sans.split(',') : [],
    issuer: b.issuer,
    notBefore: b.not_before,
    notAfter: b.not_after,
    thumbprint: b.thumbprint,
    hasKey: b.has_key,
  };
}

async function servers(db: Db) {
  return db.query<Row>(
    `SELECT s.id, COALESCE(s.display_name, s.hostname) AS name, c.name AS client, s.agent_version, s.last_seen, s.inventory, s.inventory_at
       FROM servers s LEFT JOIN clients c ON c.id = s.client_id ORDER BY lower(COALESCE(s.display_name, s.hostname))`,
  );
}

/** Routes de la page « Certificat SSL » (session requise : enregistrées dans le bloc privé). */
export function sslRoutes(priv: FastifyInstance, db: Db) {
  priv.get('/api/ssl', async () => {
    const bundle = await currentBundle(db);
    const rows = await servers(db);

    // Sans certificat déposé : noms des certificats Apache vus sur le parc, avec la prochaine expiration.
    const names = new Map<string, { cn: string; servers: number; nextExpiry: string }>();
    for (const r of rows) {
      for (const c of r.inventory?.certificates ?? []) {
        const cn = commonName(c.subject);
        if (!cn) continue;
        const e = names.get(cn) ?? { cn, servers: 0, nextExpiry: c.notAfter };
        e.servers++;
        if (c.notAfter < e.nextExpiry) e.nextExpiry = c.notAfter;
        names.set(cn, e);
      }
    }
    const fleetCerts = [...names.values()].sort((a, b) => b.servers - a.servers);
    // Serveurs équipés et leurs adresses publiques (ServerName des sites SSL, redirections).
    const domain = (bundle?.cn ?? fleetCerts[0]?.cn ?? '').replace(/^\*\./, '');
    const sites = rows.map((r) => {
      const certs = r.inventory?.certificates ?? [];
      const next = certs.reduce<(typeof certs)[number] | null>((a, c) => (!a || c.notAfter < a.notAfter ? c : a), null);
      return {
        id: r.id,
        name: r.name,
        client: r.client,
        agentVersion: r.agent_version,
        online: Boolean(r.last_seen && Date.now() - new Date(r.last_seen).getTime() < ONLINE_MS),
        known: Array.isArray(r.inventory?.apacheSites),
        links: siteLinks(r.inventory, domain),
        certNotAfter: next?.notAfter ?? null,
        certDaysLeft: next?.daysLeft ?? null,
      };
    });
    if (!bundle) return { bundle: null, agentMin: SSL_AGENT_MIN, sitesAgentMin: SITES_AGENT_MIN, domain, fleetCerts, sites, targets: [] };

    const jobs = new Map(
      (
        await db.query<JobRow>(
          'SELECT server_id, status, attempts, message, requested_at, updated_at FROM ssl_jobs WHERE bundle_id = $1',
          [bundle.id],
        )
      ).map((j) => [j.server_id, j]),
    );
    const targets = rows
      .map((r) => ({ r, certs: matchingCerts(r.inventory, bundle.cn), job: jobs.get(r.id) }))
      .filter((t) => t.certs.length || t.job)
      .map(({ r, certs, job }) => ({
        id: r.id,
        name: r.name,
        client: r.client,
        agentVersion: r.agent_version,
        agentOk: versionAtLeast(r.agent_version, SSL_AGENT_MIN),
        online: Boolean(r.last_seen && Date.now() - new Date(r.last_seen).getTime() < ONLINE_MS),
        inventoryAt: r.inventory_at,
        certs: certs.map((c) => ({ file: c.file, notAfter: c.notAfter, daysLeft: c.daysLeft })),
        upToDate: certUpToDate(certs, bundle),
        job: job
          ? { status: job.status, attempts: job.attempts, message: job.message, requestedAt: job.requested_at, updatedAt: job.updated_at }
          : null,
      }));
    return { bundle: bundleView(bundle), agentMin: SSL_AGENT_MIN, sitesAgentMin: SITES_AGENT_MIN, domain, fleetCerts, sites, targets };
  });

  // Dépôt des fichiers reçus (texte PEM lu par le navigateur) : remplace le certificat déposé précédemment.
  priv.post<{ Body: { files?: { name?: string; content?: string }[] } }>('/api/ssl', { bodyLimit: 512 * 1024 }, async (req, reply) => {
    const files = (req.body?.files ?? []).slice(0, 10).map((f) => ({ name: String(f.name ?? 'fichier').slice(0, 200), content: String(f.content ?? '') }));
    if (!files.length) return reply.code(400).send({ error: 'Aucun fichier reçu' });
    let parsed;
    try {
      parsed = parseBundle(files);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const id = randomUUID();
    await db.query('DELETE FROM ssl_bundles');
    await db.query(
      `INSERT INTO ssl_bundles (id, cn, subject, sans, issuer, not_before, not_after, thumbprint, cert_pem, chain_pem, key_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        parsed.cn,
        parsed.subject,
        parsed.sans.join(','),
        parsed.issuer,
        parsed.notBefore,
        parsed.notAfter,
        parsed.thumbprint,
        parsed.certPem,
        parsed.chainPem,
        encryptKey(parsed.keyPem),
      ],
    );
    req.log.info({ id, cn: parsed.cn, notAfter: parsed.notAfter }, 'Certificat SSL déposé');
    const [b] = await db.query<BundleRow>(`${BUNDLE_SELECT} WHERE id = $1`, [id]);
    return { bundle: bundleView(b), warnings: parsed.warnings };
  });

  // Remplacement demandé sur les serveurs choisis : l'agent s'en charge à son rapport suivant.
  priv.post<{ Body: { serverIds?: string[] } }>('/api/ssl/deploy', async (req, reply) => {
    const bundle = await currentBundle(db);
    if (!bundle) return reply.code(400).send({ error: 'Aucun certificat déposé' });
    if (!bundle.has_key) return reply.code(400).send({ error: 'Clé privée effacée : redéposer les fichiers' });
    if (new Date(bundle.not_before).getTime() > Date.now()) return reply.code(400).send({ error: 'Certificat pas encore valide' });
    const wanted = new Set((req.body?.serverIds ?? []).map(String));
    if (!wanted.size) return reply.code(400).send({ error: 'Aucun serveur choisi' });

    let queued = 0;
    const skipped: { id: string; name: string; reason: string }[] = [];
    for (const r of await servers(db)) {
      if (!wanted.has(r.id)) continue;
      const certs = matchingCerts(r.inventory, bundle.cn);
      const reason = !certs.length
        ? `aucun certificat ${bundle.cn} dans Apache`
        : !versionAtLeast(r.agent_version, SSL_AGENT_MIN)
          ? `agent ${r.agent_version ?? '?'} : ${SSL_AGENT_MIN} requis`
          : null;
      if (reason) {
        skipped.push({ id: r.id, name: r.name, reason });
        continue;
      }
      await db.query(
        `INSERT INTO ssl_jobs (bundle_id, server_id, status) VALUES ($1, $2, 'pending')
         ON CONFLICT (bundle_id, server_id) DO UPDATE
           SET status = 'pending', attempts = 0, message = NULL, requested_at = now(), updated_at = now()
           WHERE ssl_jobs.status <> 'running'`,
        [bundle.id, r.id],
      );
      queued++;
    }
    req.log.info({ bundle: bundle.id, queued, skipped: skipped.length }, 'Remplacement du certificat SSL demandé');
    return { queued, skipped };
  });

  // Annule les remplacements pas encore pris en charge par l'agent.
  priv.post<{ Body: { serverIds?: string[] } }>('/api/ssl/cancel', async (req) => {
    const ids = (req.body?.serverIds ?? []).map(String);
    const rows = await db.query(
      `DELETE FROM ssl_jobs WHERE status = 'pending' AND ($1::text[] IS NULL OR server_id::text = ANY($1::text[])) RETURNING server_id`,
      [ids.length ? ids : null],
    );
    return { cancelled: rows.length };
  });

  // Efface la clé privée de la console (parc à jour) : plus aucun remplacement possible.
  priv.delete('/api/ssl/key', async (req) => {
    await db.query("DELETE FROM ssl_jobs WHERE status = 'pending'");
    await db.query('UPDATE ssl_bundles SET key_enc = NULL');
    req.log.info('Clé privée SSL effacée de la console');
    return { ok: true };
  });

  priv.delete('/api/ssl', async (req) => {
    await db.query('DELETE FROM ssl_bundles');
    req.log.info('Certificat SSL retiré de la console');
    return { ok: true };
  });
}
