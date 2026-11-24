import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ServerSummary } from '../api';
import { Card, PageHeader, Pill, StatusBadge } from '../components/ui';
import { ago, hours } from '../format';
import { usePoll } from '../hooks';

const COLS = [
  ['ezged', 'EzGED'],
  ['apache', 'Apache'],
  ['php', 'PHP'],
  ['mariadb', 'MariaDB'],
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

/**
 * Révision EzGED : le fichier revision.txt contient selon les serveurs « 32444 » ou « 123 (31829) ».
 * Seul le numéro de révision (entre parenthèses, ou seul) se compare d'un serveur à l'autre.
 */
function ezgedRevision(v: string): string {
  return v.match(/\((\d+)\)/)?.[1] ?? v.match(/^\s*(\d+)\s*$/)?.[1] ?? v;
}

function cmpComponent(k: Key, a: string, b: string): number {
  return k === 'ezged' ? cmpVersion(ezgedRevision(a), ezgedRevision(b)) : cmpVersion(a, b);
}

/** Version Windows lisible (24H2, 22H2) ; les anciens systèmes ne remontent que « 10.0.17763 ». */
function displayVersion(v: string | null | undefined): string | null {
  return v && /^\d{2}H\d$/i.test(v) ? v.toUpperCase() : null;
}

/** Dernière mise à jour Windows au-delà de ce délai : signalée en orange. */
const STALE_UPDATE_DAYS = 45;
/** Fin de support à moins de ce délai : signalée en orange. */
const SUPPORT_WARN_DAYS = 365;

function daysSince(iso: string | null | undefined): number | null {
  return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;
}

function dateOnly(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('fr-FR') : '—';
}

type Support = 'expired' | 'soon' | 'ok' | 'unknown';

function support(s: ServerSummary): Support {
  const d = s.os?.supportDaysLeft;
  if (d === null || d === undefined) return 'unknown';
  if (d < 0) return 'expired';
  if (d < SUPPORT_WARN_DAYS) return 'soon';
  return 'ok';
}

/** Barres horizontales : une ligne par valeur, la plus fréquente ou la plus récente en premier. */
function Bars({ rows, warnIf }: { rows: [string, number][]; warnIf?: (v: string) => boolean }) {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <ul className="space-y-2.5">
      {rows.map(([v, n]) => (
        <li key={v} className="text-sm">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className={`min-w-0 break-words tabular-nums ${v === 'inconnue' ? 'text-muted' : warnIf?.(v) ? 'text-warn' : ''}`}>
              {v}
            </span>
            <span className="shrink-0 tabular-nums text-muted">{n}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#3987e5] to-[#5aa6ff]"
              style={{ width: `${(n / max) * 100}%`, boxShadow: '0 0 10px rgb(57 135 229 / 0.6)' }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function count(values: (string | null)[]): Map<string, number> {
  const m = new Map<string, number>();
  values.forEach((v) => m.set(v ?? 'inconnue', (m.get(v ?? 'inconnue') ?? 0) + 1));
  return m;
}

/** Répartition d'un composant : une barre par version, la plus récente en premier. */
function Distribution({ k, label, values, latest }: { k: Key; label: string; values: (string | null)[]; latest?: string }) {
  const cmp = (a: string, b: string) => cmpComponent(k, a, b);
  const rows = [...count(values).entries()].sort((a, b) => (a[0] === 'inconnue' ? 1 : b[0] === 'inconnue' ? -1 : cmp(b[0], a[0])));
  const upToDate = latest ? values.filter((v) => v && cmp(v, latest) >= 0).length : 0;
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
      <Bars rows={rows} warnIf={(v) => !!latest && cmp(v, latest) < 0} />
    </Card>
  );
}

/** Compteur cliquable de la synthèse système. */
function Stat({ n, label, tone }: { n: number; label: string; tone: 'ok' | 'warn' | 'crit' | 'muted' }) {
  const color = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit', muted: 'text-muted' }[tone];
  return (
    <div className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-2">
      <div className={`text-2xl font-bold tabular-nums ${n ? color : 'text-muted'}`}>{n}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function SupportCell({ s }: { s: ServerSummary }) {
  const st = support(s);
  if (st === 'unknown') return <span className="text-muted">{s.os ? 'non référencée' : '—'}</span>;
  const d = s.os!.supportDaysLeft!;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="tabular-nums">{dateOnly(s.os!.endOfSupport)}</span>
      {st === 'expired' && <Pill tone="crit">dépassée</Pill>}
      {st === 'soon' && <Pill tone="warn">dans {d} j</Pill>}
    </span>
  );
}

function OsSection({ servers }: { servers: ServerSummary[] }) {
  const withOs = servers.filter((s) => s.os);
  const editions = [...count(servers.map((s) => s.os?.caption ?? null)).entries()].sort((a, b) => b[1] - a[1]);
  const releases = [
    ...count(
      servers.map((s) =>
        s.os ? [displayVersion(s.os.version), `build ${s.os.build?.split('.')[0] ?? '?'}`].filter(Boolean).join(' · ') : null,
      ),
    ).entries(),
  ].sort((a, b) =>
    a[0] === 'inconnue'
      ? 1
      : b[0] === 'inconnue'
        ? -1
        : Number(b[0].match(/build (\d+)/)?.[1] ?? 0) - Number(a[0].match(/build (\d+)/)?.[1] ?? 0),
  );
  const sup = { expired: 0, soon: 0, ok: 0, unknown: 0 };
  servers.forEach((s) => sup[support(s)]++);
  const pending = servers.filter((s) => (s.windowsUpdatesPending ?? 0) > 0).length;
  const stale = withOs.filter((s) => (daysSince(s.os!.lastUpdateAt) ?? 0) > STALE_UPDATE_DAYS).length;
  const reboot = servers.filter((s) => s.pendingReboot).length;

  // Ordre du tableau : fin de support la plus proche d'abord, puis nom.
  const rows = [...servers].sort(
    (a, b) => (a.os?.supportDaysLeft ?? Infinity) - (b.os?.supportDaysLeft ?? Infinity) || a.name.localeCompare(b.name, 'fr'),
  );

  return (
    <section className="space-y-4">
      <h2 className="flex items-center gap-2 pt-2 text-lg font-semibold tracking-tight">
        Systèmes d'exploitation
        <span className="text-sm font-normal text-muted">{withOs.length} serveur(s) inventorié(s)</span>
      </h2>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Éditions">
          <Bars rows={editions} />
        </Card>
        <Card title="Versions et builds">
          <Bars rows={releases} />
        </Card>
        <Card title="Support Microsoft">
          <div className="grid grid-cols-2 gap-2">
            <Stat n={sup.expired} label="hors support" tone="crit" />
            <Stat n={sup.soon} label="fin < 12 mois" tone="warn" />
            <Stat n={sup.ok} label="supportés" tone="ok" />
            <Stat n={sup.unknown} label="non référencés" tone="muted" />
          </div>
        </Card>
        <Card title="Mises à jour Windows">
          <div className="grid grid-cols-2 gap-2">
            <Stat n={pending} label="MAJ en attente" tone="warn" />
            <Stat n={stale} label={`sans MAJ > ${STALE_UPDATE_DAYS} j`} tone="warn" />
            <Stat n={reboot} label="redémarrage requis" tone="warn" />
            <Stat n={servers.length - withOs.length} label="sans inventaire" tone="muted" />
          </div>
        </Card>
      </div>

      <div className="glass animate-rise overflow-x-auto rounded-xl">
        <table>
          <thead>
            <tr>
              <th>Serveur</th>
              <th>Édition</th>
              <th>Version</th>
              <th>Build</th>
              <th>Fin de support</th>
              <th>Installé le</th>
              <th>Dernière MAJ</th>
              <th>MAJ en attente</th>
              <th>Démarré</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const lastUpd = daysSince(s.os?.lastUpdateAt);
              return (
                <tr key={s.id} className="group">
                  <td className="max-w-[260px]">
                    <Link to={`/serveurs/${s.id}`} className="block truncate font-medium transition group-hover:text-accent" title={s.name}>
                      {s.name}
                    </Link>
                    <div className="truncate text-[11px] text-muted">{s.client ?? 'non affecté'}</div>
                  </td>
                  <td>{s.os?.caption ?? <span className="text-muted">—</span>}</td>
                  <td className="tabular-nums">{displayVersion(s.os?.version) ?? <span className="text-muted">—</span>}</td>
                  <td className="tabular-nums text-muted">{s.os?.build ?? '—'}</td>
                  <td>
                    <SupportCell s={s} />
                  </td>
                  <td className="tabular-nums text-muted">{dateOnly(s.os?.installDate)}</td>
                  <td
                    className={`tabular-nums ${lastUpd !== null && lastUpd > STALE_UPDATE_DAYS ? 'text-warn' : ''}`}
                    title={dateOnly(s.os?.lastUpdateAt)}
                  >
                    {s.os?.lastUpdateAt ? ago(s.os.lastUpdateAt) : <span className="text-muted">—</span>}
                  </td>
                  <td className={`tabular-nums ${s.windowsUpdatesPending ? 'text-warn' : 'text-muted'}`}>
                    {s.windowsUpdatesPending ?? '—'}
                  </td>
                  <td className="tabular-nums">
                    {s.uptimeHours === null ? '—' : `il y a ${hours(s.uptimeHours)}`}
                    {s.pendingReboot && <div className="text-[11px] text-warn">redémarrage requis</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
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
      if (vals.length) out[k] = vals.sort((a, b) => cmpComponent(k, a, b)).at(-1);
    }
    return out;
  }, [servers]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Versions"
        subtitle={
          <>
            En <span className="text-warn">orange</span> : version inférieure à la plus récente observée sur le parc, ou point à surveiller.
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {COLS.map(([k, label]) => (
          <Distribution key={k} k={k} label={label} values={servers.map((s) => s.versions[k])} latest={latest[k]} />
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
              <th>Agent</th>
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
                  const old = v && latest[k] && cmpComponent(k, v, latest[k]!) < 0;
                  return (
                    <td key={k} className="tabular-nums">
                      {!v ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span
                          className={`rounded-md px-1.5 py-0.5 ${old ? 'bg-warn/12 text-warn' : ''}`}
                          title={old ? `Plus récente sur le parc : ${latest[k]}` : undefined}
                        >
                          {v}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="tabular-nums text-muted">{s.agentVersion ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <OsSection servers={servers} />
    </div>
  );
}
