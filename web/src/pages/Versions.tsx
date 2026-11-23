import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ServerSummary } from '../api';
import { Card, PageHeader, StatusBadge } from '../components/ui';
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

/** Répartition d'un composant : une barre par version, la plus récente en premier. */
function Distribution({ label, values, latest }: { label: string; values: (string | null)[]; latest?: string }) {
  const m = new Map<string, number>();
  values.forEach((v) => m.set(v ?? 'inconnue', (m.get(v ?? 'inconnue') ?? 0) + 1));
  const rows = [...m.entries()].sort((a, b) => cmpVersion(b[0], a[0]));
  const max = Math.max(1, ...rows.map(([, n]) => n));
  const upToDate = latest ? values.filter((v) => v && cmpVersion(v, latest) >= 0).length : 0;
  return (
    <Card
      title={label}
      right={
        latest && (
          <span className="text-xs text-muted">
            <b className={upToDate === values.length ? 'text-ok' : 'text-warn'}>{upToDate}</b> / {values.length} à jour
          </span>
        )
      }
    >
      <ul className="space-y-2">
        {rows.map(([v, n]) => {
          const old = latest && v !== 'inconnue' && cmpVersion(v, latest) < 0;
          return (
            <li key={v} className="grid grid-cols-[minmax(0,9rem)_1fr_2rem] items-center gap-3 text-sm">
              <span className={`truncate tabular-nums ${v === 'inconnue' ? 'text-muted' : old ? 'text-warn' : ''}`} title={v}>
                {v}
              </span>
              <span className="h-2 overflow-hidden rounded-full bg-white/[0.05]">
                <span
                  className="block h-full rounded-full bg-gradient-to-r from-[#3987e5] to-[#5aa6ff]"
                  style={{ width: `${(n / max) * 100}%`, boxShadow: '0 0 10px rgb(57 135 229 / 0.6)' }}
                />
              </span>
              <span className="text-right tabular-nums text-muted">{n}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Versions"
        subtitle={
          <>
            En <span className="text-warn">orange</span> : version inférieure à la plus récente observée sur le parc.
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {COLS.filter(([k]) => k !== 'windows').map(([k, label]) => (
          <Distribution key={k} label={label} values={servers.map((s) => s.versions[k])} latest={latest[k]} />
        ))}
      </div>

      <div className="glass animate-rise overflow-x-auto rounded-xl">
        <table>
          <thead>
            <tr>
              <th>État</th>
              <th>Serveur</th>
              {COLS.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
              <th>MAJ Windows</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} className="group">
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td className="max-w-[320px]">
                  <Link to={`/serveurs/${s.id}`} className="block truncate font-medium transition group-hover:text-accent" title={s.name}>
                    {s.name}
                  </Link>
                  <div className="truncate text-[11px] text-muted">{s.client ?? 'non affecté'}</div>
                </td>
                {COLS.map(([k]) => {
                  const v = s.versions[k];
                  // Windows : éditions différentes (11, Server 2022...), pas de « plus récente » à comparer.
                  const old = k !== 'windows' && v && latest[k] && cmpVersion(v, latest[k]!) < 0;
                  return (
                    <td key={k} className="tabular-nums">
                      {!v ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className={`rounded-md px-1.5 py-0.5 ${old ? 'bg-warn/12 text-warn' : ''}`} title={old ? `Plus récente sur le parc : ${latest[k]}` : undefined}>
                          {v}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className={`tabular-nums ${s.windowsUpdatesPending ? 'text-warn' : 'text-muted'}`}>{s.windowsUpdatesPending ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
