import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ServerSummary } from '../api';
import { StatusDot } from '../components/ui';
import { usePoll } from '../hooks';

const COLS = [
  ['ezged', 'EzGED'],
  ['apache', 'Apache'],
  ['php', 'PHP'],
  ['mariadb', 'MariaDB'],
  ['windows', 'Windows'],
] as const;

type Key = (typeof COLS)[number][0];

/** Compare deux versions "13 (32385)", "2.4.63", "10.11.5-MariaDB" en extrayant les nombres. */
function cmpVersion(a: string, b: string): number {
  const na = a.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export default function Versions() {
  const { data } = usePoll<ServerSummary[]>('/api/servers', 120_000);
  const servers = data ?? [];

  // Version la plus récente observée sur le parc, par composant.
  const latest = useMemo(() => {
    const out: Partial<Record<Key, string>> = {};
    for (const [k] of COLS) {
      const vals = servers.map((s) => s.versions[k]).filter(Boolean) as string[];
      if (vals.length) out[k] = vals.sort(cmpVersion).at(-1);
    }
    return out;
  }, [servers]);

  // Répartition des versions EzGED.
  const ezgedDist = useMemo(() => {
    const m = new Map<string, number>();
    servers.forEach((s) => m.set(s.versions.ezged ?? 'inconnue', (m.get(s.versions.ezged ?? 'inconnue') ?? 0) + 1));
    return [...m.entries()].sort((a, b) => cmpVersion(b[0], a[0]));
  }, [servers]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="text-muted">Versions EzGED :</span>
        {ezgedDist.map(([v, n]) => (
          <span key={v} className="rounded border border-line bg-panel px-2 py-0.5">
            {v} <span className="text-muted">× {n}</span>
          </span>
        ))}
      </div>
      <p className="text-xs text-muted">
        En <span className="text-warn">orange</span> : version inférieure à la plus récente observée sur le parc.
      </p>
      <div className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table>
          <thead>
            <tr>
              <th>État</th>
              <th>Client</th>
              <th>Serveur</th>
              {COLS.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
              <th>MAJ Windows</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id}>
                <td>
                  <StatusDot status={s.status} />
                </td>
                <td className="text-muted">{s.client ?? '—'}</td>
                <td>
                  <Link to={`/serveurs/${s.id}`} className="text-accent hover:underline">
                    {s.name}
                  </Link>
                </td>
                {COLS.map(([k]) => {
                  const v = s.versions[k];
                  const old = v && latest[k] && cmpVersion(v, latest[k]!) < 0;
                  return (
                    <td key={k} className={`tabular-nums ${!v ? 'text-muted' : old ? 'text-warn' : ''}`}>
                      {v ?? '—'}
                    </td>
                  );
                })}
                <td className={s.windowsUpdatesPending ? 'text-warn' : 'text-muted'}>{s.windowsUpdatesPending ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
