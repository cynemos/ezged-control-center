import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ServerSummary, Status } from '../api';
import { Donut, Gauge, HealthLights, HealthSummary, Pill, Ring, STATUS_HEX, STATUS_LABEL, Segmented, StatusBadge } from '../components/ui';
import { ago, hours } from '../format';
import { usePoll } from '../hooks';

const ORDER: Status[] = ['critical', 'offline', 'warning', 'pending', 'ok'];
const TEXT: Record<Status, string> = {
  critical: 'text-crit',
  offline: 'text-off',
  warning: 'text-warn',
  pending: 'text-accent',
  ok: 'text-ok',
};

// Liseré et halo des tuiles selon l'état.
const TILE_FRAME: Record<Status, string> = {
  critical: 'border-crit/60 shadow-[0_0_0_1px_rgb(248_81_73/0.35),0_10px_40px_-12px_rgb(248_81_73/0.55)]',
  offline: 'border-off/50 opacity-80 saturate-50',
  warning: 'border-warn/40 shadow-[0_10px_36px_-16px_rgb(224_165_38/0.45)]',
  pending: 'border-accent/40',
  ok: 'border-line/80',
};

type View = 'tiles' | 'table';
function storedView(): View {
  try {
    return localStorage.getItem('fleet.view') === 'table' ? 'table' : 'tiles';
  } catch {
    return 'tiles';
  }
}

function backupClass(h: number | null): string {
  return h === null ? 'text-muted' : h > 26 ? 'text-warn' : 'text-text';
}

function Tile({ s, i }: { s: ServerSummary; i: number }) {
  return (
    <Link
      to={`/serveurs/${s.id}`}
      style={{ animationDelay: `${Math.min(i, 20) * 35}ms` }}
      className={`group relative flex animate-rise flex-col gap-3 overflow-hidden rounded-xl border bg-gradient-to-b from-panel-2/80 to-panel/90 p-4 backdrop-blur transition duration-200 hover:-translate-y-0.5 hover:border-accent/70 hover:shadow-[0_14px_40px_-14px_rgb(76_154_255/0.55)] ${TILE_FRAME[s.status]}`}
    >
      {/* bande de couleur en haut, lumineuse */}
      <span
        className={`absolute inset-x-0 top-0 h-[3px] ${s.status === 'critical' ? 'animate-glow' : ''}`}
        style={{ background: `linear-gradient(90deg, transparent, ${STATUS_HEX[s.status]}, transparent)` }}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted">{s.client ?? 'client non affecté'}</div>
          <div className="truncate text-[15px] font-semibold transition group-hover:text-accent" title={s.name}>
            {s.name}
          </div>
          <div className="truncate text-[11px] text-muted">
            {s.hostname}
            {s.pendingReboot && <span className="text-warn"> · redémarrage requis</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusBadge status={s.status} />
          {(s.alerts.critical > 0 || s.alerts.warning > 0) && (
            <span className="flex gap-1" title="Alertes ouvertes : critiques / avertissements">
              {s.alerts.critical > 0 && <Pill tone="crit">{s.alerts.critical}</Pill>}
              {s.alerts.warning > 0 && <Pill tone="warn">{s.alerts.warning}</Pill>}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-around rounded-lg border border-white/[0.04] bg-black/20 py-2.5">
        <Ring label="CPU" value={s.cpu} />
        <Ring label="RAM" value={s.mem} warn={85} crit={95} />
        <Ring label="Disque" value={s.diskMax} warn={90} crit={95} />
      </div>

      {s.diskFullDays !== null && s.diskFullDays < 60 && (
        <div className={`-mt-1 text-[11px] ${s.diskFullDays < 7 ? 'text-crit' : s.diskFullDays < 30 ? 'text-warn' : 'text-muted'}`}>
          Disque plein dans ~{s.diskFullDays} j au rythme actuel
        </div>
      )}

      <HealthLights lights={s.health} />

      <div className="mt-auto grid grid-cols-4 gap-2 border-t border-white/[0.06] pt-2.5 text-[11px]">
        <Meta label="Dump" title="Âge du dernier dump MariaDB">
          <span className={backupClass(s.backupAgeHours)}>{s.backupAgeHours === null ? '—' : hours(s.backupAgeHours)}</span>
        </Meta>
        <Meta label="Veeam" title="Dernière sauvegarde Veeam réussie">
          {s.veeamAgeHours === null ? <span className="text-muted">—</span> : <span className={s.veeamAgeHours > 74 ? 'text-warn' : ''}>{hours(s.veeamAgeHours)}</span>}
        </Meta>
        <Meta label="EzGED" title="Version EzGED">
          <span className="tabular-nums">{s.versions.ezged ?? '—'}</span>
        </Meta>
        <Meta label="Contact" title="Dernier rapport de l'agent">
          {ago(s.lastSeen).replace('il y a ', '')}
        </Meta>
      </div>
    </Link>
  );
}

function Meta({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10px] uppercase tracking-wider text-muted/80">{label}</div>
      <div className="truncate">{children}</div>
    </div>
  );
}

/** Synthèse : anneau de répartition des états et compteurs cliquables (filtres). */
function Overview({
  servers,
  counts,
  status,
  setStatus,
}: {
  servers: ServerSummary[];
  counts: Record<Status, number>;
  status: Status | '';
  setStatus: (s: Status | '') => void;
}) {
  const total = servers.length;
  const healthy = total ? Math.round((counts.ok / total) * 100) : 0;
  const alerts = servers.reduce((a, s) => a + s.alerts.critical + s.alerts.warning, 0);
  const reboot = servers.filter((s) => s.pendingReboot).length;
  const oldDump = servers.filter((s) => s.backupAgeHours !== null && s.backupAgeHours > 26).length;

  return (
    <section className="glass relative animate-rise overflow-hidden rounded-2xl p-5">
      <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 left-1/3 h-64 w-64 rounded-full bg-accent-2/10 blur-3xl" />
      <div className="relative flex flex-col gap-6 md:flex-row md:items-center">
        <div className="flex items-center gap-5">
          <Donut parts={ORDER.map((k) => ({ key: k, label: STATUS_LABEL[k], value: counts[k], color: STATUS_HEX[k] }))}>
            <span className="text-3xl font-bold tabular-nums">{total}</span>
            <span className="text-[11px] uppercase tracking-wider text-muted">serveurs</span>
          </Donut>
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-muted">Santé du parc</div>
            <div className="text-4xl font-bold tabular-nums">
              <span className={!total ? 'text-muted' : healthy >= 80 ? 'text-ok' : healthy >= 50 ? 'text-warn' : 'text-crit'}>{total ? healthy : '—'}</span>
              <span className="text-xl text-muted"> %</span>
            </div>
            <div className="text-xs text-muted">de serveurs sans alerte</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-xs">
              <span>
                <b className="tabular-nums">{alerts}</b> <span className="text-muted">alerte(s) ouvertes</span>
              </span>
              {reboot > 0 && (
                <span>
                  <b className="tabular-nums text-warn">{reboot}</b> <span className="text-muted">à redémarrer</span>
                </span>
              )}
              {oldDump > 0 && (
                <span>
                  <b className="tabular-nums text-warn">{oldDump}</b> <span className="text-muted">dump &gt; 26 h</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          {ORDER.map((st) => {
            const active = status === st;
            const n = counts[st];
            return (
              <button
                key={st}
                onClick={() => setStatus(active ? '' : st)}
                className={`group relative overflow-hidden rounded-xl border px-3.5 py-3 text-left transition hover:-translate-y-0.5 ${
                  active ? 'border-accent bg-accent/10 shadow-[0_0_24px_-6px_rgb(76_154_255/0.7)]' : 'border-line/70 bg-black/20 hover:border-line'
                }`}
                title={active ? 'Retirer le filtre' : `Afficher seulement : ${STATUS_LABEL[st]}`}
              >
                <span
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ background: STATUS_HEX[st], opacity: n ? 1 : 0.25, boxShadow: n ? `0 0 12px ${STATUS_HEX[st]}` : undefined }}
                />
                <div className={`text-3xl font-bold tabular-nums ${n ? TEXT[st] : 'text-muted/50'}`} style={n ? { textShadow: `0 0 18px ${STATUS_HEX[st]}` } : undefined}>
                  {n}
                </div>
                <div className="text-xs text-muted">{STATUS_LABEL[st]}</div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
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

  const empty = !loading && rows.length === 0 && (
    <p className="py-12 text-center text-muted">
      {servers.length === 0 ? (
        <>
          Aucun serveur.{' '}
          <Link to="/ajouter" className="text-accent">
            Installer un premier agent
          </Link>
          .
        </>
      ) : (
        'Aucun serveur ne correspond aux filtres.'
      )}
    </p>
  );

  return (
    <div className="space-y-5">
      <Overview servers={servers} counts={counts} status={status} setStatus={setStatus} />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            ['tiles', 'Tuiles'],
            ['table', 'Tableau'],
          ]}
        />
        <div className="relative w-72 max-w-full">
          <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="9" cy="9" r="6" />
            <path d="m14 14 4 4" strokeLinecap="round" />
          </svg>
          <input placeholder="Rechercher serveur, client, version…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full !pl-9" />
        </div>
        <select value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">Tous les clients</option>
          {clients.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        {status && (
          <button onClick={() => setStatus('')} className="rounded-full border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs text-accent">
            {STATUS_LABEL[status]} ✕
          </button>
        )}
        <span className="text-xs text-muted">
          {rows.length} / {servers.length}
        </span>
        {view === 'tiles' && (
          <button onClick={toggleFull} className="ml-auto text-xs text-muted transition hover:text-text">
            {full ? 'Quitter le plein écran' : 'Plein écran (mur de supervision)'}
          </button>
        )}
      </div>

      {error && <p className="text-crit">{error}</p>}

      {view === 'tiles' && (
        <>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]">
            {rows.map((s, i) => (
              <Tile key={s.id} s={s} i={i} />
            ))}
          </div>
          {empty}
        </>
      )}

      {view === 'table' && (
        <div className="glass animate-rise overflow-x-auto rounded-xl">
          <table>
            <thead>
              <tr>
                <th>État</th>
                <th>Serveur</th>
                <th>CPU</th>
                <th>RAM</th>
                <th>Disque max</th>
                <th>Dump</th>
                <th>Veeam</th>
                <th className="min-w-[200px]">Santé</th>
                <th>EzGED</th>
                <th>Alertes</th>
                <th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="group">
                  <td className="relative">
                    <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full" style={{ background: STATUS_HEX[s.status] }} />
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="max-w-[340px]">
                    <Link to={`/serveurs/${s.id}`} className="block truncate font-medium text-text transition group-hover:text-accent" title={s.name}>
                      {s.name}
                    </Link>
                    <div className="flex items-center gap-1.5 truncate text-[11px] text-muted">
                      <span className={s.client ? '' : 'italic'}>{s.client ?? 'non affecté'}</span>
                      <span>·</span>
                      <span>{s.hostname}</span>
                      {s.pendingReboot && <span className="text-warn">· redémarrage requis</span>}
                    </div>
                  </td>
                  <td>
                    <Gauge value={s.cpu} />
                  </td>
                  <td>
                    <Gauge value={s.mem} warn={85} crit={95} />
                  </td>
                  <td>
                    <Gauge value={s.diskMax} warn={90} crit={95} />
                  </td>
                  <td className={`tabular-nums ${backupClass(s.backupAgeHours)}`}>{s.backupAgeHours === null ? '—' : hours(s.backupAgeHours)}</td>
                  <td className={`tabular-nums ${s.veeamAgeHours === null ? 'text-muted' : s.veeamAgeHours > 74 ? 'text-warn' : ''}`}>
                    {s.veeamAgeHours === null ? '—' : hours(s.veeamAgeHours)}
                  </td>
                  <td className="whitespace-normal">
                    <HealthSummary lights={s.health} />
                  </td>
                  <td className="tabular-nums">{s.versions.ezged ?? '—'}</td>
                  <td>
                    <span className="flex gap-1">
                      {s.alerts.critical > 0 && <Pill tone="crit">{s.alerts.critical} crit.</Pill>}
                      {s.alerts.warning > 0 && <Pill tone="warn">{s.alerts.warning} alerte</Pill>}
                      {!s.alerts.critical && !s.alerts.warning && <span className="text-muted">—</span>}
                    </span>
                  </td>
                  <td className="text-xs text-muted">{ago(s.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {empty}
        </div>
      )}
    </div>
  );
}
