import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from './config.js';
import type { Db } from './db.js';
import { sha256 } from './auth.js';

// Déploiement de l'agent par script (TeamViewer Remote Management, GPO, RMM...) :
// un jeton de déploiement limité en durée et en nombre d'installations remplace la clé
// d'enrôlement, qui n'apparaît ainsi jamais dans le script distribué.

const AGENT_DIRS = [config.agentScript ? dirname(config.agentScript) : '', '../agent', '../../agent']
  .filter(Boolean)
  .map((p) => resolve(p));

async function agentFile(name: string): Promise<Buffer | null> {
  for (const dir of AGENT_DIRS) {
    const p = join(dir, name);
    if (existsSync(p)) return readFile(p);
  }
  return null;
}

const VALID = 'revoked_at IS NULL AND expires_at > now() AND uses < max_uses';

/** Jeton utilisable (sans le consommer), pour servir le script d'installation. */
export async function deployTokenValid(db: Db, token: string): Promise<boolean> {
  if (!token) return false;
  const rows = await db.query(`SELECT 1 FROM deploy_tokens WHERE token_hash = $1 AND ${VALID}`, [sha256(token)]);
  return rows.length > 0;
}

/** Consomme une installation du jeton ; renvoie son id, ou null s'il est invalide, expiré ou épuisé. */
export async function consumeDeployToken(db: Db, token: string): Promise<string | null> {
  if (!token) return null;
  const [row] = await db.query<{ id: string }>(
    `UPDATE deploy_tokens SET uses = uses + 1 WHERE token_hash = $1 AND ${VALID} RETURNING id`,
    [sha256(token)],
  );
  return row?.id ?? null;
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Script à enregistrer dans l'outil de déploiement (exécuté en administrateur sur chaque serveur).
 * Il ne contient que l'adresse de la console et le jeton de déploiement.
 */
export function launcherScript(token: string, label: string, expiresAt: Date): string {
  const until = expiresAt.toISOString().slice(0, 16).replace('T', ' ');
  return [
    `# EzGed ControlCenter : installation de l'agent (jeton "${label.replace(/[^\x20-\x7E]/g, '?')}", valable jusqu'au ${until} UTC)`,
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '$wc = New-Object Net.WebClient',
    `$wc.Headers.Add('X-Deploy-Token', ${psQuote(token)})`,
    `Invoke-Expression $wc.DownloadString(${psQuote(`${config.publicUrl}/api/agent/bootstrap`)})`,
    '',
  ].join('\r\n');
}

/**
 * Script servi par /api/agent/bootstrap : dépose install-agent.ps1 et l'agent dans un dossier
 * temporaire et lance l'installeur avec le jeton de déploiement. Uniquement de l'ASCII (PowerShell 3.0).
 */
export async function bootstrapScript(token: string): Promise<string | null> {
  const installer = await agentFile('install-agent.ps1');
  const agent = await agentFile('ezged-cc-agent.ps1');
  if (!installer || !agent) return null;
  return [
    '# EzGed ControlCenter : script d\'installation genere par la console',
    "$dir = Join-Path $env:TEMP ('ezgedcc-' + [guid]::NewGuid().ToString('N'))",
    'New-Item -ItemType Directory -Path $dir -Force | Out-Null',
    '$code = 1',
    'try {',
    `  [IO.File]::WriteAllBytes((Join-Path $dir 'install-agent.ps1'), [Convert]::FromBase64String('${installer.toString('base64')}'))`,
    `  [IO.File]::WriteAllBytes((Join-Path $dir 'ezged-cc-agent.ps1'), [Convert]::FromBase64String('${agent.toString('base64')}'))`,
    '  # Outil de deploiement 32 bits sur Windows 64 bits : passer par Sysnative pour un PowerShell 64 bits',
    '  # (registre, Program Files et tache planifiee du vrai systeme).',
    "  $ps = Join-Path $env:windir 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "  if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { $ps = Join-Path $env:windir 'Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe' }",
    `  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $dir 'install-agent.ps1') -ServerUrl ${psQuote(config.publicUrl)} -DeployToken ${psQuote(token)}`,
    '  $code = $LASTEXITCODE',
    '} finally {',
    '  Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
    'if ($code -ne 0) { throw "Installation de l\'agent EzGed ControlCenter en echec (code $code)" }',
    '',
  ].join('\r\n');
}
