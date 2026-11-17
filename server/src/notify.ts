import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';

let transporter: Transporter | null = null;
function mailer() {
  if (!config.smtpHost || !config.alertEmailTo) return null;
  transporter ??= nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
  });
  return transporter;
}

/** Envoie une notification sur tous les canaux configurés. N'échoue jamais : les erreurs sont journalisées. */
export async function notify(subject: string, body: string, log: (msg: string) => void): Promise<void> {
  const text = `${subject}\n${body}`;
  const jobs: Promise<unknown>[] = [];

  if (config.webhookUrl) {
    // Format { text } : accepté par Slack, Mattermost, Discord (via /slack) et les workflows Teams simples.
    jobs.push(
      fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
  }
  if (config.telegramToken && config.telegramChatId) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.telegramChatId, text }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
  }
  const m = mailer();
  if (m) {
    jobs.push(m.sendMail({ from: config.smtpFrom || config.smtpUser, to: config.alertEmailTo, subject, text: body }));
  }

  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === 'rejected') log(`Notification échouée : ${String(r.reason)}`);
  }
}
