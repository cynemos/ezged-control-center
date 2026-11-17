// Configuration lue depuis les variables d'environnement (ou un fichier .env en dev).
try {
  process.loadEnvFile();
} catch {
  /* pas de .env : on utilise l'environnement tel quel */
}

const env = process.env;

function num(name: string, def: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && env[name] !== undefined && env[name] !== '' ? v : def;
}

export const config = {
  port: num('PORT', 3000),
  host: env.HOST ?? '0.0.0.0',
  // true uniquement derrière un reverse proxy (Caddy) : sinon X-Forwarded-For serait falsifiable.
  trustProxy: env.TRUST_PROXY === '1',
  production: env.NODE_ENV === 'production',

  // PostgreSQL si DATABASE_URL est défini, sinon base embarquée PGlite (dev / petit parc).
  databaseUrl: env.DATABASE_URL ?? '',
  pgliteDir: env.PGLITE_DIR ?? './data/pglite',

  adminUser: env.ADMIN_USER ?? 'admin',
  adminPassword: env.ADMIN_PASSWORD ?? '',
  adminTotpSecret: env.ADMIN_TOTP_SECRET ?? '',
  sessionSecret: env.SESSION_SECRET ?? '',
  sessionHours: num('SESSION_HOURS', 12),

  // Clé partagée utilisée une seule fois par l'installeur d'agent pour obtenir son jeton.
  enrollKey: env.ENROLL_KEY ?? '',
  publicUrl: (env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),

  offlineMinutes: num('OFFLINE_MINUTES', 5),
  retentionDays: num('RETENTION_DAYS', 30),

  // Notifications (toutes optionnelles)
  webhookUrl: env.ALERT_WEBHOOK_URL ?? '',
  telegramToken: env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: env.TELEGRAM_CHAT_ID ?? '',
  smtpHost: env.SMTP_HOST ?? '',
  smtpPort: num('SMTP_PORT', 465),
  smtpSecure: (env.SMTP_SECURE ?? '1') === '1',
  smtpUser: env.SMTP_USER ?? '',
  smtpPassword: env.SMTP_PASSWORD ?? '',
  smtpFrom: env.SMTP_FROM ?? '',
  alertEmailTo: env.ALERT_EMAIL_TO ?? '',
};

export function assertConfig(): void {
  const problems: string[] = [];
  if (config.adminPassword.length < 12) problems.push('ADMIN_PASSWORD (12 caractères minimum)');
  if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET (32 caractères minimum)');
  if (config.enrollKey.length < 24) problems.push('ENROLL_KEY (24 caractères minimum)');
  if (problems.length) {
    throw new Error(`Configuration invalide, variables manquantes ou trop courtes : ${problems.join(', ')}`);
  }
}
