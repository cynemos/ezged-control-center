import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ServerSummary, Status } from '../api';
import { Gauge, Pill, STATUS_LABEL, StatusDot } from '../components/ui';
import { ago, hours } from '../format';
import { usePoll } from '../hooks';

const ORDER: Status[] = ['critical', 'offline', 'warning', 'pending', 'ok'];
const TILE_COLOR: Record<Status, string> = {
  critical: 'text-crit',
  offline: 'text-off',
  warning: 'text-warn',
  pending: 'text-accent',
  ok: 'text-ok',
};

export default function Fleet() {
  const { data, error, loading } = usePoll<ServerSummary[]>('/api/servers');
  const [q, setQ] = useState('');
  const [client, setClient] = useState('');
  const [status, setStatus] = useState<Status | ''>('');

  const servers = data ?? [];
  const clients = useMemo(() => [...new Set(servers.map((s) => s.client).filter(Boolean))].sort() as string[], [servers]);
  const counts = useMemo(() => {
    const c: Record<Status, number> = { critical: 0, offline: 0, warning: 0, pending: 0, ok: 0 };
    servers.forEach((s) => c[s.status]++);
    return c;
  }, [servers]);

  const rows = servers
    .filter((s) => !status || s.status === status)
    .filter((s) => !client || s.client === client)
    .filter((s) => {
      const t = q.trim().toLowerCase();
      return !t || [s.name, s.hostname, s.client ?? '', s.versions.ezged ?? ''].some((v) => v.toLowerCase().includes(t));
    })
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (a.client ?? '~').localeCompare(b.client ?? '~') || a.name.localeCompare(b.name));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <button
          onClick={() => setStatus('')}
          className={`rounded-lg border bg-panel p-3 text-left ${status === '' ? 'border-accent' : 'border-line'}`}
        >
          <div className="text-2xl font-semibold tabular-nums">{servers.length}</div>
          <div className="text-xs text-muted">Serveurs</div>
        </button>
        {ORDER.map((st) => (
          <button
            key={st}
            onClick={() => setStatus(status === st ? '' : st)}
            className={`rounded-lg border bg-panel p-3 text-left ${status === st ? 'border-accent' : 'border-line'}`}
          >
            <div className={`text-2xl font-semibold tabular-nums ${counts[st] ? TILE_COLOR[st] : 'text-muted'}`}>{counts[st]}</div>
            <div className="text-xs text-muted">{STATUS_LABEL[st]}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <input placeholder="Rechercher serveur, client, version…" value={q} onChange={(e) => setQ(e.target.value)} className="w-72 max-w-full" />
        <select value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">Tous les clients</option>
          {clients.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-crit">{error}</p>}

      <div className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table>
          <thead>
            <tr>
              <th>État</th>
              <th>Client</th>
              <th>Serveur</th>
              <th>Dernier contact</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>Disque max</th>
              <th>Sauvegarde</th>
              <th>EzGED</th>
              <th>Alertes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <StatusDot status={s.status} />
                </td>
                <td className="text-muted">{s.client ?? <span className="italic">non affecté</span>}</td>
                <td>
                  <Link to={`/serveurs/${s.id}`} className="font-medium text-accent hover:underline">
                    {s.name}
                  </Link>
                  {s.name !== s.hostname && <span className="ml-2 text-xs text-muted">{s.hostname}</span>}
                  {s.pendingReboot && (
                    <span className="ml-2">
                      <Pill tone="muted">redémarrage requis</Pill>
                    </span>
                  )}
                </td>
                <td className="text-muted">{ago(s.lastSeen)}</td>
                <td>
                  <Gauge value={s.cpu} />
                </td>
                <td>
                  <Gauge value={s.mem} warn={85} crit={95} />
                </td>
                <td>
                  <Gauge value={s.diskMax} warn={90} crit={95} />
                </td>
                <td className={s.backupAgeHours === null ? 'text-muted' : s.backupAgeHours > 26 ? 'text-warn' : ''}>
                  {s.backupAgeHours === null ? '—' : hours(s.backupAgeHours)}
                </td>
                <td className="tabular-nums">{s.versions.ezged ?? '—'}</td>
                <td className="space-x-1">
                  {s.alerts.critical > 0 && <Pill tone="crit">{s.alerts.critical} crit.</Pill>}
                  {s.alerts.warning > 0 && <Pill tone="warn">{s.alerts.warning}</Pill>}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-8 text-center text-muted">
                  {servers.length === 0 ? (
                    <>
                      Aucun serveur. <Link to="/ajouter" className="text-accent">Installer un premier agent</Link>.
                    </>
                  ) : (
                    'Aucun serveur ne correspond aux filtres.'
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
