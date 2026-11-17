import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

export const SESSION_COOKIE = 'ezgedcc_session';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Comparaison à temps constant, quelle que soit la longueur des chaînes. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---- Session : cookie signé HMAC, sans état côté serveur ----

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function createSession(user: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: user, exp: Date.now() + config.sessionHours * 3600_000 }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readSession(value: string | undefined): { u: string } | null {
  if (!value) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return { u: String(data.u) };
  } catch {
    return null;
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const session = readSession(req.cookies[SESSION_COOKIE]);
  if (!session) {
    return reply.code(401).send({ error: 'Non authentifié' });
  }
}

// ---- TOTP (RFC 6238), compatible Google Authenticator / Microsoft Authenticator ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/** Accepte le code courant et ±1 pas de 30 s pour absorber un léger décalage d'horloge. */
export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => safeEqual(hotp(key, step + d), code));
}
