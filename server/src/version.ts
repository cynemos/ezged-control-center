import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Version de la console : première ligne de VERSION.txt, écrite par build-package.ps1
// (« v0.6.3 257d70f 2026-11-24T10:00:00 ») et posée à la racine de l'installation
// (InstallDir\VERSION.txt, le service tournant dans InstallDir\app\server). Absent en dev.

export interface ConsoleVersion {
  version: string;
  commit: string | null;
  builtAt: string | null;
}

function read(): ConsoleVersion {
  for (const p of ['../../VERSION.txt', '../VERSION.txt', 'VERSION.txt'].map((x) => resolve(x))) {
    if (!existsSync(p)) continue;
    const [version, commit, builtAt] = readFileSync(p, 'latin1').trim().split(/\s+/);
    if (version) return { version, commit: commit ?? null, builtAt: builtAt ?? null };
  }
  return { version: 'dev', commit: null, builtAt: null };
}

export const consoleVersion: ConsoleVersion = read();
export const startedAt = new Date().toISOString();
