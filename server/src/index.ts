import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { checkOffline } from './alerts.js';
import { assertConfig, config } from './config.js';
import { openDb } from './db.js';
import { agentRoutes } from './routes/agent.js';
import { apiRoutes } from './routes/api.js';

assertConfig();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || (config.production ? 'info' : 'debug') },
  // Derrière Caddy / un reverse proxy : l'IP réelle vient de X-Forwarded-For.
  trustProxy: config.trustProxy,
  // Publication sous un préfixe (BASE_PATH) : le préfixe est retiré s'il est présent, que le proxy
  // l'ait déjà enlevé ou non. Les routes internes restent /api/..., /assets/...
  rewriteUrl: (req) => {
    const url = req.url ?? '/';
    const base = config.basePath;
    if (!base || !url.startsWith(base)) return url;
    const rest = url.slice(base.length);
    if (rest === '' || rest.startsWith('/') || rest.startsWith('?')) return rest.startsWith('/') ? rest : `/${rest}`;
    return url;
  },
});

const db = await openDb();

await app.register(cookie);
await app.register(rateLimit, { global: false });

agentRoutes(app, db);
apiRoutes(app, db);

// Interface web compilée (web/dist), servie en mode application monopage.
const webDist = resolve(process.env.WEB_DIST ?? '../web/dist');
if (existsSync(webDist)) {
  // wildcard (défaut) : les fichiers sont lus à la demande, un nouveau build est servi sans redémarrage.
  // index.html est servi à part : sa balise <base> reçoit le préfixe de publication.
  await app.register(fastifyStatic, { root: webDist, index: false });
  const indexHtml = resolve(webDist, 'index.html');
  const sendIndex = async (_req: unknown, reply: import('fastify').FastifyReply) => {
    const html = (await readFile(indexHtml, 'utf8')).replace(/<base href="[^"]*"\s*\/?>/, `<base href="${config.basePath}/" />`);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
  };
  app.get('/', sendIndex);
  app.setNotFoundHandler((req, reply) => {
    // Repli SPA uniquement pour les routes de l'interface, jamais pour un fichier manquant (/assets/x.js).
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path)) return sendIndex(req, reply);
    return reply.code(404).send({ error: 'Introuvable' });
  });
} else {
  app.log.warn(`Interface web absente (${webDist}) : lancez "npm run build" dans web/`);
}

const log = (msg: string) => app.log.warn(msg);

// Détection des serveurs muets, toutes les minutes.
setInterval(() => void checkOffline(db, log).catch((e) => app.log.error(e)), 60_000);

// Purge quotidienne de l'historique.
async function purge() {
  await db.query(`DELETE FROM metrics WHERE ts < now() - ($1 || ' days')::interval`, [String(config.retentionDays)]);
  await db.query(`DELETE FROM alerts WHERE closed_at < now() - interval '180 days'`);
}
setInterval(() => void purge().catch((e) => app.log.error(e)), 24 * 3600_000);

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
