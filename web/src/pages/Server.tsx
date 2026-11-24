import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type AlertRow, type ServerSummary } from '../api';
import { Button, Card, Gauge, HealthLights, Kv, Pill, Ring, STATUS_HEX, Segmented, StatusBadge } from '../components/ui';
import { ago, bytes, dateTime, hours } from '../format';
import { usePoll } from '../hooks';

interface Detail extends ServerSummary {
  notes: string | null;
  enrolledAt: string;
  lastIp: string | null;
  inventoryAt: string | null;
  snapshot: any;
  inventory: any;
  alertList: AlertRow[];
  versionHistory: { component: string; old_version: string | null; new_version: string; changed_at: string }[];
}

interface Point {
  ts: string;
  cpu: number | null;
  mem: number | null;
  disk_max: number | null;
  http_ms: number | null;
  queue_total: number | null;
}

const RANGES = [
  ['24h', '24 h'],
  ['7d', '7 jours'],
  ['30d', '30 jours'],
] as const;

export default function Server() {
  const { id } = useParams();
  const { data: s, error, reload } = usePoll<Detail>(`/api/servers/${id}`);
  const [range, setRange] = useState<string>('24h');
  const { data: points } = usePoll<Point[]>(`/api/servers/${id}/metrics?range=${range}`, 60_000);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (error) return <p className="text-crit">{error}</p>;
  if (!s) return <p className="text-muted">Chargement…</p>;

  const snap = s.snapshot ?? {};
  const inv = s.inventory ?? {};
  const m = snap.metrics ?? {};

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted transition hover:text-text">
        ← Parc
      </Link>

      <section className="glass relative animate-rise overflow-hidden rounded-2xl p-5">
        <span
          className={`absolute inset-x-0 top-0 h-[3px] ${s.status === 'critical' ? 'animate-glow' : ''}`}
          style={{ background: `linear-gradient(90deg, transparent, ${STATUS_HEX[s.status]}, transparent)` }}
        />
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full blur-3xl" style={{ background: STATUS_HEX[s.status], opacity: 0.12 }} />
        <div className="relative flex flex-wrap items-center gap-6">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{s.client ?? 'client non affecté'}</div>
            <h1 className="break-words text-2xl font-bold tracking-tight">{s.name}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              <StatusBadge status={s.status} />
              <span>Dernier contact {ago(s.lastSeen)}</span>
              <span>{s.hostname}</span>
              {s.lastIp && <span>IP {s.lastIp}</span>}
              <span>Agent {s.agentVersion ?? '?'}</span>
            </div>
            <div className="pt-1">
              <HealthLights lights={s.health} size="md" />
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-xl border border-white/[0.05] bg-black/25 px-5 py-3">
            <Ring label="CPU" value={m.cpu} size={72} stroke={6} />
            <Ring label="RAM" value={m.memUsedPct} warn={85} crit={95} size={72} stroke={6} />
            <Ring label="Disque" value={s.diskMax} warn={90} crit={95} size={72} stroke={6} />
          </div>
        </div>
        <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
          {s.teamviewerId && <TeamViewerButton id={s.teamviewerId} />}
          {s.rustdeskId && (
            <a href={`rustdesk://${encodeURIComponent(s.rustdeskId)}`} className={REMOTE_BTN}>
              Prendre la main (RustDesk)
            </a>
          )}
          {!s.teamviewerId && !s.rustdeskId && <span className="text-xs text-muted">Pas d'ID TeamViewer ni RustDesk</span>}
          <span className="ml-auto flex gap-2">
            <Button onClick={() => setEditing(!editing)}>Modifier</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Supprimer
            </Button>
          </span>
        </div>
      </section>

      {deleting && <DeleteConfirm s={s} onCancel={() => setDeleting(false)} />}

      {editing && <EditForm s={s} onDone={() => { setEditing(false); void reload(); }} />}

      {s.alertList.some((a) => !a.closed_at) && (
        <Card title="Alertes en cours" className="!border-crit/30">
          <ul className="space-y-2">
            {s.alertList
              .filter((a) => !a.closed_at)
              .map((a) => (
                <li key={a.id} className="flex items-center gap-3 rounded-lg bg-black/20 px-3 py-2 text-sm">
                  <Pill tone={a.severity === 'critical' ? 'crit' : 'warn'}>{a.severity === 'critical' ? 'Critique' : 'Alerte'}</Pill>
                  <span>{a.message}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{ago(a.opened_at)}</span>
                </li>
              ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Système">
          <Kv
            rows={[
              ['Windows', inv.os ? `${inv.os.caption} ${inv.os.version ?? ''}` : null],
              ['Build', inv.os?.build],
              ['Matériel', inv.hardware ? `${inv.hardware.model ?? ''} · ${inv.hardware.cores ?? '?'} cœurs` : null],
              ['CPU', <Gauge value={m.cpu} />],
              ['RAM', <span><Gauge value={m.memUsedPct} warn={85} crit={95} /> <span className="text-xs text-muted">sur {bytes((m.memTotalMB ?? 0) * 1048576)}</span></span>],
              ['Démarré', m.uptimeHours !== undefined ? `il y a ${hours(m.uptimeHours)}` : null],
              ['Redémarrage', snap.pendingReboot ? <Pill tone="warn">requis</Pill> : 'non requis'],
              ['Mises à jour', inv.windowsUpdates ? `${inv.windowsUpdates.pending ?? '?'} en attente · dernière ${dateTime(inv.windowsUpdates.lastInstalledAt)}` : null],
            ]}
          />
        </Card>

        <Card title="Versions" right={<span className="text-xs text-muted">inventaire {ago(s.inventoryAt)}</span>}>
          <Kv
            rows={[
              ['EzGED', s.versions.ezged],
              ['Apache', s.versions.apache],
              ['PHP', s.versions.php],
              ['MariaDB', s.versions.mariadb],
              ['Dépôt EzGED', inv.ezged?.repository],
              ['Base', inv.ezged ? `${inv.ezged.database ?? '?'} · ${inv.ezged.dbSizeMB ?? '?'} Mo` : null],
              ['Documents', docsLabel(inv.ezged?.docs)],
            ]}
          />
        </Card>

        <Card title="Services et accès">
          <ul className="space-y-1.5 text-sm">
            {(snap.services ?? []).map((sv: any) => (
              <li key={sv.name} className="flex items-center justify-between">
                <span>{sv.name}</span>
                <Pill tone={sv.status === 'Running' ? 'ok' : 'crit'}>{sv.status}</Pill>
              </li>
            ))}
            {([
              ['Démon EzGED', snap.http],
              ...(snap.apache ?? []).map((h: any) => [`Apache ${h.url.startsWith('https') ? 'HTTPS' : 'HTTP'} :${new URL(h.url).port || (h.url.startsWith('https') ? 443 : 80)}`, h]),
              ['Page publique', snap.web],
            ] as [string, any][])
              .filter(([, h]) => h)
              .map(([label, h]) => (
              <li key={label} className="flex items-center justify-between gap-2">
                <span className="truncate" title={h.url}>{label} <span className="text-xs text-muted">{h.url}</span></span>
                <Pill tone={h.ok ? 'ok' : 'crit'}>{h.status ?? 'erreur'} · {h.ms} ms</Pill>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Processus surveillés" className="lg:col-span-2">
          {(snap.processes ?? []).length ? (
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Processus</th>
                    <th>CPU</th>
                    <th>Mémoire</th>
                    <th>Handles</th>
                    <th>Threads</th>
                    <th>Démarré</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.processes.map((p: any) => {
                    const upMin = p.startedAt ? (Date.now() - new Date(p.startedAt).getTime()) / 60_000 : null;
                    return (
                      <tr key={p.service}>
                        <td>{p.service}</td>
                        <td className="text-muted">
                          {p.name}
                          {p.count > 1 && <span className="text-xs"> ×{p.count}</span>}
                        </td>
                        <td>{p.cpuPct === null ? <span className="text-muted">—</span> : <Gauge value={p.cpuPct} warn={70} crit={90} />}</td>
                        <td className="tabular-nums">{bytes(p.memMB * 1048576)}</td>
                        <td className={`tabular-nums ${p.handles > 10000 ? 'text-warn' : ''}`}>{p.handles}</td>
                        <td className="tabular-nums">{p.threads}</td>
                        <td className={upMin !== null && upMin < 60 ? 'text-warn' : 'text-muted'}>{p.startedAt ? ago(p.startedAt) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">Disponible à partir de l'agent 0.2.0.</p>
          )}
        </Card>

        <Card title="Agent">
          <Kv
            rows={[
              ['Version', s.agentVersion],
              ['Durée collecte', snap.agent?.durationMs !== undefined ? <span className={snap.agent.durationMs > 45000 ? 'text-warn' : ''}>{(snap.agent.durationMs / 1000).toFixed(1)} s</span> : null],
              ['PowerShell', snap.agent?.ps],
              ['.NET', dotnetLabel(snap.agent?.dotnet)],
              ['Mise à jour auto', snap.agent ? (snap.agent.autoUpdate ? 'acceptée' : 'refusée') : null],
              [
                'Collectes',
                snap.agent ? (
                  snap.agent.errors?.length ? (
                    <ul className="space-y-0.5 text-warn">
                      {snap.agent.errors.map((e: any) => (
                        <li key={e.name}>
                          {e.name} : <span className="text-xs">{e.error}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-ok">toutes OK</span>
                  )
                ) : null,
              ],
            ]}
          />
        </Card>

        <Card title="Matériel et journaux" right={<span className="text-xs text-muted">24 dernières heures</span>}>
          {snap.events || snap.disksHealth || snap.logs ? (
            <div className="space-y-3 text-sm">
              {snap.events && (
                <Kv
                  rows={[
                    ['Écrans bleus', <Count n={snap.events.bugchecks} crit />],
                    ['Arrêts inattendus', <Count n={snap.events.shutdowns} />],
                    ['Erreurs disque', <Count n={snap.events.diskErrors} crit />],
                    ['Erreurs NTFS', <Count n={snap.events.ntfsErrors} />],
                  ]}
                />
              )}
              {snap.events?.last?.length > 0 && (
                <ul className="space-y-1 border-t border-line pt-2 text-xs">
                  {snap.events.last.map((e: any, i: number) => (
                    <li key={i}>
                      <span className="text-muted">{dateTime(e.at)} · {e.source} {e.id}</span> {e.message}
                    </li>
                  ))}
                </ul>
              )}
              {(snap.disksHealth ?? []).length > 0 && (
                <ul className="space-y-1 border-t border-line pt-2">
                  {snap.disksHealth.map((d: any, i: number) => {
                    const bad = d.predictFailure === true || /unhealthy/i.test(d.health ?? '');
                    const warn = /warning/i.test(d.health ?? '') || (d.status && !/^ok$/i.test(d.status));
                    return (
                      <li key={i} className="flex items-center justify-between gap-2">
                        <span className="truncate" title={d.model}>
                          {d.model} <span className="text-xs text-muted">{d.sizeGB} Go</span>
                        </span>
                        <Pill tone={bad ? 'crit' : warn ? 'warn' : 'ok'}>
                          {d.predictFailure === true ? 'panne prédite' : d.health ?? d.status}
                          {d.predictFailure === null && d.health === null ? '' : d.predictFailure === false ? ' · SMART OK' : ''}
                        </Pill>
                      </li>
                    );
                  })}
                </ul>
              )}
              {snap.logs && Object.keys(snap.logs).length > 0 && (
                <div className="space-y-1 border-t border-line pt-2">
                  {Object.entries(snap.logs).map(([name, l]: [string, any]) => (
                    <div key={name}>
                      <div className="flex justify-between">
                        <span>Journal {name === 'mariadb' ? 'MariaDB' : 'Apache'}</span>
                        <span className={l.errors ? (name === 'mariadb' ? 'text-warn' : '') : 'text-muted'}>{l.errors} erreur(s)</span>
                      </div>
                      {l.last && <div className="truncate text-xs text-muted" title={l.last}>{l.last}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">Disponible à partir de l'agent 0.3.0.</p>
          )}
        </Card>

        <Card title="Disques">
          <ul className="space-y-1.5 text-sm">
            {(m.disks ?? []).map((d: any) => (
              <li key={d.name} className="flex items-center justify-between">
                <span>{d.name} <span className="text-xs text-muted">{d.freeGB} Go libres / {d.sizeGB} Go</span></span>
                <Gauge value={d.usedPct} warn={90} crit={95} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Sauvegarde MariaDB">
          <Kv
            rows={[
              ['Dernier dump', snap.backup?.lastFile],
              ['Date', dateTime(snap.backup?.lastAt)],
              ['Âge', <span className={snap.backup?.ageHours > 26 ? 'text-warn' : ''}>{hours(snap.backup?.ageHours)}</span>],
              [
                'Taille',
                <span>
                  {bytes(snap.backup?.sizeBytes)}
                  {snap.backup?.prevSizeBytes ? <span className="text-xs text-muted"> · précédent {bytes(snap.backup.prevSizeBytes)}</span> : null}
                </span>,
              ],
              ['Dossier', snap.backup?.dir],
            ]}
          />
        </Card>

        {snap.veeam && (
          <Card title="Veeam Agent" right={<span className="text-xs text-muted">{snap.veeam.version}</span>}>
            <Kv
              rows={[
                ['Service', <span className={snap.veeam.service === 'Running' ? '' : 'text-crit'}>{snap.veeam.service}</span>],
                ['Tâche', snap.veeam.job],
                [
                  'Dernier résultat',
                  <span className={snap.veeam.lastResult === 'Failed' ? 'text-crit' : snap.veeam.lastResult === 'Warning' ? 'text-warn' : ''}>
                    {snap.veeam.lastResult ?? '—'}
                    {snap.veeam.lastAt && ` · ${dateTime(snap.veeam.lastAt)}`}
                  </span>,
                ],
                ['Dernière réussite', <span className={snap.veeam.okAgeHours > 74 ? 'text-warn' : ''}>{hours(snap.veeam.okAgeHours)}</span>],
                ['Détail', snap.veeam.details],
                ['En cours', snap.veeam.running ? `oui, depuis ${dateTime(snap.veeam.runningSince)}` : 'non'],
              ]}
            />
          </Card>
        )}

        <Card title="Files de traitement EzGED">
          <ul className="space-y-1.5 text-sm">
            {Object.entries(snap.queues ?? {}).map(([name, q]: [string, any]) => (
              <li key={name} className="flex items-center justify-between">
                <span>{name}</span>
                <span className={q.oldestMin >= 60 ? 'text-warn' : q.count ? '' : 'text-muted'}>
                  {q.count} fichier(s){q.oldestMin !== null && ` · plus ancien ${hours(q.oldestMin / 60)}`}
                </span>
              </li>
            ))}
          </ul>
          {!Object.keys(snap.queues ?? {}).length && !snap.db && <p className="text-sm text-muted">Pas encore de données.</p>}
          {snap.db && (
            <div className="mt-3 border-t border-line pt-3 text-sm">
              {snap.db.ok ? (
                <Kv rows={[['Connexions', `${snap.db.threadsConnected} (max atteint ${snap.db.maxUsedConnections})`], ['Requêtes lentes', snap.db.slowQueries]]} />
              ) : (
                <span className="text-crit">MariaDB : {snap.db.error}</span>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Historique"
        right={
          <Segmented size="sm" value={range} onChange={setRange} options={RANGES} />
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <Chart title="CPU / RAM / disque (%)" points={points ?? []} range={range} series={[['cpu', 'CPU', '#3987e5'], ['mem', 'RAM', '#d95926'], ['disk_max', 'Disque max', '#199e70']]} max={100} />
          <Chart title="Temps de réponse EzGED (ms)" points={points ?? []} range={range} series={[['http_ms', 'Réponse', '#3987e5']]} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Changements de version">
          {s.versionHistory.length === 0 ? (
            <p className="text-sm text-muted">Aucun changement détecté depuis l'installation de l'agent.</p>
          ) : (
            <table>
              <tbody>
                {s.versionHistory.map((v, i) => (
                  <tr key={i}>
                    <td className="text-muted">{dateTime(v.changed_at)}</td>
                    <td>{v.component}</td>
                    <td className="text-muted">{v.old_version ?? '—'}</td>
                    <td>→ {v.new_version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Certificats SSL">
          {(inv.certificates ?? []).length === 0 ? (
            <p className="text-sm text-muted">Aucun certificat trouvé dans la configuration Apache.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {inv.certificates.map((c: any) => (
                <li key={c.file} className="flex justify-between gap-2">
                  <span className="truncate" title={c.file}>{c.subject}</span>
                  <Pill tone={c.daysLeft <= 3 ? 'crit' : c.daysLeft <= 15 ? 'warn' : 'ok'}>{c.daysLeft} j</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {s.notes && (
        <Card title="Notes">
          <p className="whitespace-pre-wrap text-sm">{s.notes}</p>
        </Card>
      )}
    </div>
  );
}

function Chart({ title, points, series, range, max }: { title: string; points: Point[]; series: [keyof Point, string, string][]; range: string; max?: number }) {
  const fmt = (ts: string) =>
    new Date(ts).toLocaleString('fr-FR', range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit' });
  const single = series.length === 1;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className="font-medium text-text">{title}</span>
        {!single &&
          series.map(([, label, color]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: color }} />
              {label}
            </span>
          ))}
      </div>
      {points.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">Pas encore de données.</p>
      ) : (
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={points} margin={{ top: 6, right: 10, left: -12, bottom: 0 }}>
            <defs>
              {series.map(([key, , color]) => (
                <linearGradient key={String(key)} id={`g-${String(key)}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={single ? 0.35 : 0.14} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke="rgb(255 255 255 / 0.05)" vertical={false} />
            <XAxis dataKey="ts" tickFormatter={fmt} stroke="#8a9ab3" fontSize={11} minTickGap={40} tickLine={false} axisLine={{ stroke: '#20304b' }} />
            <YAxis stroke="#8a9ab3" fontSize={11} domain={max ? [0, max] : ['auto', 'auto']} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ stroke: '#8a9ab3', strokeDasharray: '3 3' }}
              contentStyle={{ background: 'rgb(13 20 34 / 0.95)', border: '1px solid #20304b', borderRadius: 10, fontSize: 12, boxShadow: '0 10px 30px -10px #000' }}
              labelStyle={{ color: '#8a9ab3' }}
              itemStyle={{ color: '#e8eef8' }}
              labelFormatter={(v) => new Date(v as string).toLocaleString('fr-FR')}
            />
            {series.map(([key, label, color]) => (
              <Area
                key={label}
                type="monotone"
                dataKey={key}
                name={label}
                stroke={color}
                fill={`url(#g-${String(key)})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: '#0d1422' }}
                strokeWidth={2}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

const REMOTE_BTN =
  'rounded-lg border border-accent/70 bg-gradient-to-b from-[#5aa6ff] to-[#3b82f6] px-3.5 py-1.5 text-sm font-medium text-white shadow-[0_6px_20px_-8px_rgb(76_154_255/0.8)] transition hover:brightness-110';

// Stockage des documents : taille, nombre de fichiers, date du calcul (quotidien côté agent).
// Ouvre le client TeamViewer installé sur le poste (gestionnaire d'URL teamviewer10://) sur l'ID du serveur,
// et copie l'ID au passage au cas où le lien ne serait pas pris en charge par la version installée.
function TeamViewerButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const spaced = id.replace(/(\d{3})(?=\d)/g, '$1 ');
  return (
    <span className="flex items-center gap-2">
      <a
        href={`teamviewer10://control?device=${encodeURIComponent(id)}`}
        onClick={() => {
          navigator.clipboard?.writeText(id).then(() => setCopied(true), () => undefined);
        }}
        className={REMOTE_BTN}
        title="Ouvre TeamViewer sur ce serveur (l'ID est aussi copié)"
      >
        Prendre la main (TeamViewer)
      </a>
      <span className="font-mono text-xs text-muted">{copied ? 'ID copié' : spaced}</span>
    </span>
  );
}

function Count({ n, crit = false }: { n: number; crit?: boolean }) {
  if (!n) return <span className="text-muted">0</span>;
  return <span className={crit ? 'font-medium text-crit' : 'font-medium text-warn'}>{n}</span>;
}

function dotnetLabel(release: number | null | undefined): string | null {
  if (!release) return null;
  const v = release >= 533320 ? '4.8.1' : release >= 528040 ? '4.8' : release >= 461808 ? '4.7.2' : release >= 460798 ? '4.7' : release >= 394802 ? '4.6.2' : release >= 393295 ? '4.6' : release >= 379893 ? '4.5.2' : '4.5';
  return `${v} (${release})`;
}

function docsLabel(d: any): string | null {
  if (!d) return null;
  if (d.found === false) return `introuvable (${d.dir})`;
  const size = d.sizeGB >= 1 ? `${d.sizeGB.toLocaleString('fr-FR')} Go` : `${Math.round(d.sizeGB * 1024)} Mo`;
  const files = `${Number(d.files).toLocaleString('fr-FR')} fichiers`;
  return `${d.partial ? '≥ ' : ''}${size} · ${files} · ${ago(d.at)}`;
}

// Confirmation dans la page (pas de confirm() natif, que certains navigateurs bloquent).
function DeleteConfirm({ s, onCancel }: { s: Detail; onCancel: () => void }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/servers/${s.id}`, { method: 'DELETE' });
      nav('/');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="animate-rise rounded-xl border border-crit/60 bg-crit/10 p-4 text-sm shadow-[0_0_30px_-10px_var(--color-crit)]">
      <p>
        Supprimer <strong>{s.name}</strong> ({s.hostname}) de la console, avec tout son historique ? Cette action est
        définitive. Si l'agent tourne encore sur ce serveur, ses rapports seront refusés jusqu'à sa réinstallation.
      </p>
      {err && <p className="mt-2 text-crit">Échec de la suppression : {err}</p>}
      <div className="mt-3 flex gap-2">
        <Button variant="danger" onClick={remove} disabled={busy}>
          {busy ? 'Suppression…' : 'Confirmer la suppression'}
        </Button>
        <Button onClick={onCancel} disabled={busy}>Annuler</Button>
      </div>
    </div>
  );
}

function EditForm({ s, onDone }: { s: Detail; onDone: () => void }) {
  const [displayName, setDisplayName] = useState(s.name === s.hostname ? '' : s.name);
  const [clientName, setClientName] = useState(s.client ?? '');
  const [rustdeskId, setRustdeskId] = useState(s.rustdeskId ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  const { data: clients } = usePoll<{ id: number; name: string }[]>('/api/clients', 600_000);

  const save = async () => {
    await api(`/api/servers/${s.id}`, { method: 'PATCH', json: { displayName, clientName, rustdeskId, notes } });
    onDone();
  };

  return (
    <Card title="Modifier le serveur">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs text-muted">Nom affiché</span>
          <input className="w-full" placeholder={s.hostname} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          {s.teamviewerId && (
            <span className="block text-xs text-muted">
              {s.nameManual
                ? 'Saisi à la main : TeamViewer ne le change plus. Vider pour reprendre le nom TeamViewer.'
                : 'Suit le nom TeamViewer ; une modification ici le fige.'}
            </span>
          )}
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted">Client</span>
          <input className="w-full" list="clients" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          <datalist id="clients">{clients?.map((c) => <option key={c.id} value={c.name} />)}</datalist>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted">ID RustDesk</span>
          <input className="w-full" value={rustdeskId} onChange={(e) => setRustdeskId(e.target.value)} />
        </label>
        <label className="space-y-1 sm:col-span-3">
          <span className="text-xs text-muted">Notes (contacts, particularités…)</span>
          <textarea className="w-full" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={save}>Enregistrer</Button>
        <Button onClick={onDone}>Annuler</Button>
      </div>
    </Card>
  );
}
