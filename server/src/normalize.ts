import type { Snapshot } from './types.js';

// Windows PowerShell déballe un tableau d'un seul élément : ConvertTo-Json produit alors un objet
// au lieu d'une liste (un seul disque, un seul processus...). On remet ces champs en tableau,
// à la réception d'un rapport comme à la lecture d'un instantané déjà stocké.
function asArray<T>(v: T | T[] | null | undefined): T[] | undefined {
  if (v === null || v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

export function normalizeSnapshot<S extends Snapshot | null | undefined>(snap: S): S {
  if (!snap || typeof snap !== 'object') return snap;
  const s = snap as Snapshot;
  if (s.metrics) s.metrics.disks = asArray(s.metrics.disks);
  s.services = asArray(s.services);
  s.processes = asArray(s.processes);
  s.apache = asArray(s.apache);
  s.disksHealth = asArray(s.disksHealth);
  if (s.events) s.events.last = asArray(s.events.last) ?? [];
  if (s.agent) s.agent.errors = asArray(s.agent.errors) ?? [];
  return snap;
}
