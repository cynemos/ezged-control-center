import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, X509Certificate, type KeyObject } from 'node:crypto';
import { config } from './config.js';
import type { Db } from './db.js';
import type { Inventory } from './types.js';

// Certificat SSL commun aux serveurs EzGED (wildcard renouvelé chaque année) : déposé dans la console,
// puis remplacé par l'agent sur chaque serveur dont le certificat Apache porte le même nom.

/** Version minimale de l'agent qui sait remplacer le certificat. */
export const SSL_AGENT_MIN = '0.4.0';
/** Un remplacement sans résultat depuis ce délai est reproposé (agent coupé pendant l'opération...). */
export const SSL_STALE_MS = 20 * 60_000;
/** Nombre de tentatives avant de déclarer l'échec sans réponse de l'agent. */
export const SSL_MAX_ATTEMPTS = 3;

export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  const a = String(v ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// ---------------------------------------------------------------- lecture des fichiers déposés

export interface ParsedBundle {
  cn: string;
  subject: string;
  sans: string[];
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  /** Empreinte SHA-1 en hexadécimal majuscule, comme X509Certificate2.Thumbprint côté agent. */
  thumbprint: string;
  certPem: string;
  chainPem: string;
  keyPem: string;
  warnings: string[];
}

const PEM_RE = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

/** Nom commun (CN) d'un sujet, au format Node (« CN=x\nO=y ») ou .NET (« CN=x, O=y »). */
export function commonName(subject: string | null | undefined): string {
  const m = /(?:^|[\n,]\s*)CN=([^,\n]+)/i.exec(String(subject ?? ''));
  return m ? m[1].trim().toLowerCase() : '';
}

/**
 * Lit les fichiers reçus (certificat, clé, chaîne : dans n'importe quel ordre, PEM uniquement),
 * retrouve le certificat qui correspond à la clé et reconstitue la chaîne. Lève une erreur lisible.
 */
export function parseBundle(files: { name: string; content: string }[]): ParsedBundle {
  const certs: X509Certificate[] = [];
  const keys: { pem: string; key: KeyObject }[] = [];
  for (const f of files) {
    const text = String(f.content ?? '');
    const blocks = text.match(PEM_RE) ?? [];
    if (!blocks.length) throw new Error(`${f.name} : pas au format PEM (texte « -----BEGIN … ») ; un fichier .pfx n'est pas accepté`);
    for (const block of blocks) {
      const type = /-----BEGIN ([A-Z0-9 ]+)-----/.exec(block)![1];
      if (type === 'CERTIFICATE') {
        try {
          certs.push(new X509Certificate(block));
        } catch {
          throw new Error(`${f.name} : certificat illisible`);
        }
      } else if (type === 'ENCRYPTED PRIVATE KEY' || /Proc-Type: 4,ENCRYPTED/.test(block)) {
        throw new Error(`${f.name} : clé privée protégée par un mot de passe ; Apache ne peut pas la lire au démarrage`);
      } else if (/PRIVATE KEY$/.test(type)) {
        try {
          keys.push({ pem: block.replace(/\r\n/g, '\n'), key: createPrivateKey(block) });
        } catch {
          throw new Error(`${f.name} : clé privée illisible`);
        }
      }
    }
  }
  if (keys.length !== 1) throw new Error(keys.length ? 'Plusieurs clés privées reçues : une seule attendue' : 'Clé privée absente (fichier .key)');
  const key = keys[0];
  const leaf = certs.find((c) => c.checkPrivateKey(key.key));
  if (!leaf) throw new Error('Aucun des certificats reçus ne correspond à la clé privée');

  // Chaîne : de l'émetteur du certificat jusqu'à la racine, dans l'ordre attendu par Apache.
  const others = certs.filter((c) => c !== leaf && !c.checkPrivateKey(key.key));
  const chain: X509Certificate[] = [];
  let current = leaf;
  while (chain.length < 10) {
    const next = others.find((c) => !chain.includes(c) && current.checkIssued(c) && current.verify(c.publicKey));
    if (!next) break;
    chain.push(next);
    if (next.checkIssued(next)) break; // racine auto-signée
    current = next;
  }
  const warnings: string[] = [];
  if (!chain.length) {
    throw new Error("Chaîne de certification absente ou incomplète : le fichier .ca-bundle doit contenir l'autorité qui a signé le certificat");
  }
  const unused = others.filter((c) => !chain.includes(c)).length;
  if (unused) warnings.push(`${unused} certificat(s) du bundle sans rapport avec la chaîne, écarté(s)`);

  const notBefore = new Date(leaf.validFrom);
  const notAfter = new Date(leaf.validTo);
  if (notAfter.getTime() < Date.now()) throw new Error(`Certificat expiré le ${notAfter.toLocaleDateString('fr-FR')}`);
  if (notBefore.getTime() > Date.now()) warnings.push(`Certificat valide seulement à partir du ${notBefore.toLocaleString('fr-FR')}`);
  const cn = commonName(leaf.subject);
  if (!cn) throw new Error('Certificat sans nom commun (CN)');

  return {
    cn,
    subject: leaf.subject.replace(/\n/g, ', '),
    sans: (leaf.subjectAltName ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^DNS:/, ''))
      .filter(Boolean),
    issuer: leaf.issuer.replace(/\n/g, ', '),
    notBefore,
    notAfter,
    thumbprint: leaf.fingerprint.replace(/:/g, '').toUpperCase(),
    certPem: leaf.toString().replace(/\r\n/g, '\n'),
    chainPem: chain.map((c) => c.toString().replace(/\r\n/g, '\n')).join(''),
    keyPem: key.pem.endsWith('\n') ? key.pem : key.pem + '\n',
    warnings,
  };
}

// ---------------------------------------------------------------- clé privée chiffrée en base

// Clé de chiffrement dérivée de SESSION_SECRET : changer ce secret rend la clé privée stockée illisible
// (il suffit alors de redéposer les fichiers).
function cipherKey(): Buffer {
  return createHash('sha256').update(`ezgedcc-ssl:${config.sessionSecret}`).digest();
}

export function encryptKey(pem: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cipherKey(), iv);
  const ct = Buffer.concat([c.update(pem, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptKey(stored: string): string {
  const raw = Buffer.from(stored, 'base64');
  const d = createDecipheriv('aes-256-gcm', cipherKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- serveurs concernés

export interface BundleRow {
  id: string;
  uploaded_at: Date;
  cn: string;
  subject: string;
  sans: string;
  issuer: string;
  not_before: Date;
  not_after: Date;
  thumbprint: string;
  has_key: boolean;
}

export const BUNDLE_SELECT =
  'SELECT id, uploaded_at, cn, subject, sans, issuer, not_before, not_after, thumbprint, key_enc IS NOT NULL AS has_key FROM ssl_bundles';

export async function currentBundle(db: Db): Promise<BundleRow | null> {
  const [b] = await db.query<BundleRow>(`${BUNDLE_SELECT} ORDER BY uploaded_at DESC LIMIT 1`);
  return b ?? null;
}

type InvCert = NonNullable<Inventory['certificates']>[number];

/** Certificats Apache du serveur portant le nom du certificat déposé. */
export function matchingCerts(inv: Inventory | null | undefined, cn: string): InvCert[] {
  return (inv?.certificates ?? []).filter((c) => commonName(c.subject) === cn);
}

export interface SiteLink {
  url: string;
  host: string;
  port: number;
  /** Nom couvert par le certificat commun (ex. xx.digitged.fr pour *.digitged.fr). */
  inDomain: boolean;
}

const LOCAL_HOST = /^(localhost|127\.|\[?::1\]?$|\d+\.\d+\.\d+\.\d+$)/i;

/**
 * Adresses publiques HTTPS d'un serveur, tirées de sa configuration Apache : ServerName / ServerAlias
 * des sites SSL et cibles des redirections. Les noms du domaine du certificat commun passent en tête.
 */
export function siteLinks(inv: Inventory | null | undefined, domain: string): SiteLink[] {
  const out = new Map<string, SiteLink>();
  const add = (host: string, port: number) => {
    host = host.trim().toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9.-]+$/.test(host) || LOCAL_HOST.test(host)) return; // variables ($1...), jokers, adresses locales
    const url = `https://${host}${port === 443 ? '' : `:${port}`}/`;
    if (!out.has(url)) out.set(url, { url, host, port, inDomain: Boolean(domain) && (host === domain || host.endsWith(`.${domain}`)) });
  };
  for (const s of inv?.apacheSites ?? []) {
    if (s.ssl) {
      for (const name of [s.serverName, ...(s.aliases ?? [])]) {
        if (!name) continue;
        const m = /^(?:https?:\/\/)?([^:/\s]+)(?::(\d+))?/i.exec(name.replace(/^"|"$/g, ''));
        if (m) add(m[1], m[2] ? Number(m[2]) : (s.port ?? 443));
      }
    }
    for (const r of s.redirects ?? []) {
      try {
        const u = new URL(r);
        if (u.protocol === 'https:') add(u.hostname, u.port ? Number(u.port) : 443);
      } catch {
        /* cible de redirection avec variables ($1...) : ignorée */
      }
    }
  }
  return [...out.values()].sort((a, b) => Number(b.inDomain) - Number(a.inDomain));
}

/** Le serveur présente-t-il déjà ce certificat ? Empreinte si l'agent la remonte, sinon date d'expiration. */
export function certUpToDate(certs: InvCert[], bundle: Pick<BundleRow, 'thumbprint' | 'not_after'>): boolean {
  if (!certs.length) return false;
  return certs.every((c) =>
    c.thumbprint ? c.thumbprint.toUpperCase() === bundle.thumbprint : Math.abs(new Date(c.notAfter).getTime() - new Date(bundle.not_after).getTime()) < 60_000,
  );
}
