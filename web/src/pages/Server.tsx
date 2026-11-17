import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type AlertRow, type ServerSummary } from '../api';
import { Button, Card, Gauge, Kv, Pill, StatusDot } from '../components/ui';
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

  if (error) return <p className="text-crit">{error}</p>;
  if (!s) return <p className="text-muted">Chargement…</p>;

  const snap = s.snapshot ?? {};
  const inv = s.inventory ?? {};
  const m = snap.metrics ?? {};

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <Link to="/" className="text-sm text-muted hover:text-text">
            ← Parc
          </Link>
          <h1 className="mt-1 text-xl font-semibold">
            {s.name} <span className="text-sm font-normal text-muted">{s.client ?? 'client non affecté'}</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted">
            <StatusDot status={s.status} />
            <span>Dernier contact {ago(s.lastSeen)}</span>
            <span>{s.hostname}</span>
            {s.lastIp && <span>IP {s.lastIp}</span>}
            <span>Agent {s.agentVersion ?? '?'}</span>
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          {s.rustdeskId ? (
            <a href={`rustdesk://${encodeURIComponent(s.rustdeskId)}`} className="rounded-md border border-accent bg-accent/90 px-3 py-1.5 text-sm text-white hover:bg-accent">
              Prendre la main (RustDesk)
            </a>
          ) : (
            <span className="self-center text-xs text-muted">Pas d'ID RustDesk</span>
          )}
          <Button onClick={() => setEditing(!editing)}>Modifier</Button>
        </div>
      </div>

      {editing && <EditForm s={s} onDone={() => { setEditing(false); void reload(); }} />}

      {s.alertList.some((a) => !a.closed_at) && (
        <Card title="Alertes en cours">
          <ul className="space-y-1.5">
            {s.alertList
              .filter((a) => !a.closed_at)
              .map((a) => (
                <li key={a.id} className="flex items-center gap-3 text-sm">
                  <Pill tone={a.severity === 'critical' ? 'crit' : 'warn'}>{a.severity === 'critical' ? 'Critique' : 'Alerte'}</Pill>
                  <span>{a.message}</span>
                  <span className="text-xs text-muted">{ago(a.opened_at)}</span>
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
            {([['Serveur EzGED (interne)', snap.http], ['Page publique', snap.web]] as [string, any][])
              .filter(([, h]) => h)
              .map(([label, h]) => (
              <li key={label} className="flex items-center justify-between gap-2">
                <span className="truncate" title={h.url}>{label} <span className="text-xs text-muted">{h.url}</span></span>
                <Pill tone={h.ok ? 'ok' : 'crit'}>{h.status ?? 'erreur'} · {h.ms} ms</Pill>
              </li>
            ))}
          </ul>
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
              ['Taille', bytes(snap.backup?.sizeBytes)],
              ['Dossier', snap.backup?.dir],
            ]}
          />
        </Card>

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
          <div className="flex gap-1">
            {RANGES.map(([k, label]) => (
              <button key={k} onClick={() => setRange(k)} className={`rounded px-2 py-0.5 text-xs ${range === k ? 'bg-panel-2 text-text' : 'text-muted'}`}>
                {label}
              </button>
            ))}
          </div>
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <Chart title="CPU / RAM / disque (%)" points={points ?? []} range={range} series={[['cpu', 'CPU', '#4c9aff'], ['mem', 'RAM', '#a371f7'], ['disk_max', 'Disque max', '#d29922']]} max={100} />
          <Chart title="Temps de réponse EzGED (ms)" points={points ?? []} range={range} series={[['http_ms', 'Réponse', '#3fb950']]} />
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
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className="font-medium text-text">{title}</span>
        {series.map(([, label, color]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>
      {points.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">Pas encore de données.</p>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={points} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="#2a3442" vertical={false} />
            <XAxis dataKey="ts" tickFormatter={fmt} stroke="#8b98a8" fontSize={11} minTickGap={40} />
            <YAxis stroke="#8b98a8" fontSize={11} domain={max ? [0, max] : ['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: '#151b23', border: '1px solid #2a3442', borderRadius: 6, fontSize: 12 }}
              labelFormatter={(v) => new Date(v as string).toLocaleString('fr-FR')}
            />
            {series.map(([key, label, color]) => (
              <Line key={label} type="linear" dataKey={key} name={label} stroke={color} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function EditForm({ s, onDone }: { s: Detail; onDone: () => void }) {
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState(s.name === s.hostname ? '' : s.name);
  const [clientName, setClientName] = useState(s.client ?? '');
  const [rustdeskId, setRustdeskId] = useState(s.rustdeskId ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  const { data: clients } = usePoll<{ id: number; name: string }[]>('/api/clients', 600_000);

  const save = async () => {
    await api(`/api/servers/${s.id}`, { method: 'PATCH', json: { displayName, clientName, rustdeskId, notes } });
    onDone();
  };
  const remove = async () => {
    if (!confirm(`Supprimer ${s.name} de la console, avec tout son historique ? L'agent devra être réinstallé pour réapparaître.`)) return;
    await api(`/api/servers/${s.id}`, { method: 'DELETE' });
    nav('/');
  };

  return (
    <Card title="Modifier le serveur">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs text-muted">Nom affiché</span>
          <input className="w-full" placeholder={s.hostname} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
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
        <span className="ml-auto">
          <Button variant="danger" onClick={remove}>Supprimer</Button>
        </span>
      </div>
    </Card>
  );
}
