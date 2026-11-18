import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ServerSummary, Status } from '../api';
import { Gauge, HealthLights, MiniBar, Pill, STATUS_LABEL, StatusDot } from '../components/ui';
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

const TILE_BORDER: Record<Status, string> = {
  critical: 'border-crit/70 shadow-[0_0_0_1px_var(--color-crit)]',
  offline: 'border-off/70 opacity-80',
  warning: 'border-warn/60',
  pending: 'border-accent/50',
  ok: 'border-line',
};
const TILE_BAND: Record<Status, string> = {
  critical: 'bg-crit',
  offline: 'bg-off',
  warning: 'bg-warn',
  pending: 'bg-accent',
  ok: 'bg-ok',
};

type View = 'tiles' | 'table';
function storedView(): View {
  try {
    return localStorage.getItem('fleet.view') === 'table' ? 'table' : 'tiles';
  } catch {
    return 'tiles';
  }
}

function Tile({ s }: { s: ServerSummary }) {
  const backup = s.backupAgeHours;
  return (
    <Link
      to={`/serveurs/${s.id}`}
      className={`group relative flex flex-col gap-2.5 overflow-hidden rounded-lg border bg-panel p-3 pl-4 transition hover:border-accent ${TILE_BORDER[s.status]}`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${TILE_BAND[s.status]} ${s.status === 'critical' ? 'animate-pulse' : ''}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs text-muted">
            {s.client ?? 'non affecté'}
            {s.pendingReboot && <span className="text-warn"> · redémarrage requis</span>}
          </div>
          <div className="truncate font-semibold group-hover:text-accent">{s.name}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusDot status={s.status} />
          {(s.alerts.critical > 0 || s.alerts.warning > 0) && (
            <span className="space-x-1">
              {s.alerts.critical > 0 && <Pill tone="crit">{s.alerts.critical}</Pill>}
              {s.alerts.warning > 0 && <Pill tone="warn">{s.alerts.warning}</Pill>}
            </span>
          )}
        </div>
      </div>
      <div className="flex gap-3">
        <MiniBar label="CPU" value={s.cpu} />
        <MiniBar label="RAM" value={s.mem} warn={85} crit={95} />
        <MiniBar label="Disque" value={s.diskMax} warn={90} crit={95} />
      </div>
      <HealthLights lights={s.health} />
      <div className="flex justify-between gap-2 text-[11px] text-muted">
        <span title="Âge du dernier dump MariaDB">
          Dump <span className={backup === null ? '' : backup > 26 ? 'text-warn' : 'text-text'}>{backup === null ? '—' : hours(backup)}</span>
        </span>
        {s.veeamAgeHours !== null && (
          <span title="Dernière sauvegarde Veeam réussie">
            Veeam <span className={s.veeamAgeHours > 74 ? 'text-warn' : 'text-text'}>{hours(s.veeamAgeHours)}</span>
          </span>
        )}
        <span className="tabular-nums" title="Version EzGED">{s.versions.ezged ?? '—'}</span>
        <span title="Dernier contact">{ago(s.lastSeen)}</span>
      </div>
    </Link>
  );
}

export default function Fleet() {
  const { data, error, loading } = usePoll<ServerSummary[]>('/api/servers');
  const [view, setView] = useState<View>(storedView);
  const [full, setFull] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem('fleet.view', view);
    } catch {
      /* stockage indisponible : préférence non mémorisée */
    }
  }, [view]);
  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };
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

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-line text-sm">
          {(['tiles', 'table'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 ${view === v ? 'bg-accent/90 text-white' : 'bg-panel-2 text-muted hover:text-text'}`}
            >
              {v === 'tiles' ? 'Tuiles' : 'Tableau'}
            </button>
          ))}
        </div>
        <input placeholder="Rechercher serveur, client, version…" value={q} onChange={(e) => setQ(e.target.value)} className="w-72 max-w-full" />
        <select value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">Tous les clients</option>
          {clients.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-crit">{error}</p>}

      {view === 'tiles' && (
        <>
          <div className="flex justify-end">
            <button onClick={toggleFull} className="text-xs text-muted hover:text-text">
              {full ? 'Quitter le plein écran' : 'Plein écran (mur de supervision)'}
            </button>
          </div>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {rows.map((s) => (
              <Tile key={s.id} s={s} />
            ))}
          </div>
          {!loading && rows.length === 0 && (
            <p className="py-8 text-center text-muted">
              {servers.length === 0 ? (
                <>
                  Aucun serveur. <Link to="/ajouter" className="text-accent">Installer un premier agent</Link>.
                </>
              ) : (
                'Aucun serveur ne correspond aux filtres.'
              )}
            </p>
          )}
        </>
      )}

      {view === 'table' && <div className="overflow-x-auto rounded-lg border border-line bg-panel">
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
              <th>Santé</th>
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
                <td>
                  <HealthLights lights={s.health} />
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
                <td colSpan={11} className="py-8 text-center text-muted">
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
      </div>}
    </div>
  );
}
