import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Button, PageHeader, Pill, Segmented } from '../components/ui';
import { ago, dateTime } from '../format';
import { usePoll } from '../hooks';

export interface TvCandidate {
  tvId: string;
  alias: string;
  client: string | null;
  group: string;
  online: boolean | null;
  lastSeen: string | null;
  ignored: boolean;
}

export interface TvStatus {
  enabled: boolean;
  lastSyncAt: string | null;
  error: string | null;
  warning: string | null;
  groups?: { wanted: string[]; found: string[] };
  toDeploy?: TvCandidate[];
}

const spaced = (id: string) => id.replace(/(\d{3})(?=\d)/g, '$1 ');

// Appareils des groupes TeamViewer EzGED dont aucun agent ne remonte l'ID : serveurs à équiper.
export default function ToDeploy() {
  const { data, reload } = usePoll<TvStatus>('/api/teamviewer', 60_000);
  const [view, setView] = useState<'todo' | 'ignored'>('todo');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  if (!data) return null;

  const all = data.toDeploy ?? [];
  const todo = all.filter((c) => !c.ignored);
  const ignored = all.filter((c) => c.ignored);
  const rows = view === 'todo' ? todo : ignored;
  const online = todo.filter((c) => c.online).length;

  async function sync() {
    setBusy(true);
    try {
      await api('/api/teamviewer/sync', { method: 'POST' });
    } finally {
      setBusy(false);
      void reload();
    }
  }

  async function setIgnored(c: TvCandidate, value: boolean) {
    await api('/api/teamviewer/ignore', { method: 'POST', json: { tvId: c.tvId, alias: c.alias, ignored: value } });
    void reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agents à déployer"
        subtitle={
          data.enabled ? (
            <>
              Appareils du groupe TeamViewer {(data.groups?.found.length ? data.groups.found : data.groups?.wanted)?.join(', ') || 'EzGED'} sans agent de supervision :{' '}
              <b className={todo.length ? 'text-warn' : 'text-ok'}>{todo.length}</b> à équiper, dont {online} en ligne.
            </>
          ) : (
            'Synchronisation TeamViewer désactivée.'
          )
        }
        right={
          data.enabled && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted">Synchro {data.lastSyncAt ? ago(data.lastSyncAt) : 'jamais'}</span>
              <Button onClick={sync} disabled={busy}>
                {busy ? 'Synchronisation…' : 'Synchroniser'}
              </Button>
            </div>
          )
        }
      />

      {!data.enabled && (
        <div className="glass rounded-xl p-5 text-sm">
          Ajouter <code>TEAMVIEWER_API_TOKEN</code> dans le <code>.env</code> de la console (voir la page{' '}
          <Link to="/ajouter" className="text-accent">
            Ajouter un serveur
          </Link>
          ), puis redémarrer le service.
        </div>
      )}
      {data.error && <div className="rounded-xl border border-crit/50 bg-crit/10 p-4 text-sm text-crit">{data.error}</div>}
      {data.warning && <div className="rounded-xl border border-warn/40 bg-warn/5 p-4 text-sm text-warn">{data.warning}</div>}

      {data.enabled && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              value={view}
              onChange={setView}
              options={[
                ['todo', `À équiper (${todo.length})`],
                ['ignored', `Ignorés (${ignored.length})`],
              ]}
            />
            <span className="text-xs text-muted">
              Pour équiper un serveur : prendre la main, puis lancer le script de{' '}
              <Link to="/ajouter" className="text-accent">
                déploiement
              </Link>
              . Il quitte cette liste à la synchro suivante.
            </span>
          </div>

          <div className="glass animate-rise overflow-x-auto rounded-xl">
            <table>
              <thead>
                <tr>
                  <th>TeamViewer</th>
                  <th>Appareil</th>
                  <th>Client déduit</th>
                  <th>ID</th>
                  <th>Dernière connexion</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.tvId}>
                    <td>
                      {c.online === null ? (
                        <Pill tone="muted">inconnu</Pill>
                      ) : c.online ? (
                        <Pill tone="ok">en ligne</Pill>
                      ) : (
                        <Pill tone="muted">hors ligne</Pill>
                      )}
                    </td>
                    <td className="min-w-[200px] max-w-[360px] whitespace-normal font-medium">{c.alias}</td>
                    <td className="text-muted">{c.client ?? '—'}</td>
                    <td className="font-mono text-xs text-muted">{copied === c.tvId ? 'ID copié' : spaced(c.tvId)}</td>
                    <td className="text-xs text-muted" title={dateTime(c.lastSeen)}>
                      {c.online ? 'maintenant' : c.lastSeen ? ago(c.lastSeen) : '—'}
                    </td>
                    <td className="text-right">
                      <span className="inline-flex items-center gap-3">
                        <a
                          href={`teamviewer10://control?device=${encodeURIComponent(c.tvId)}`}
                          onClick={() =>
                            navigator.clipboard?.writeText(c.tvId).then(
                              () => setCopied(c.tvId),
                              () => undefined,
                            )
                          }
                          className="rounded-md border border-accent/50 px-2 py-0.5 text-xs text-accent transition hover:bg-accent/10"
                          title="Ouvre TeamViewer sur cet appareil (l'ID est aussi copié)"
                        >
                          Prendre la main
                        </a>
                        <button
                          onClick={() => setIgnored(c, !c.ignored)}
                          className="text-xs text-muted transition hover:text-text"
                          title={
                            c.ignored
                              ? 'Remettre dans la liste à équiper'
                              : 'Pas un serveur EzGED, ou pas à superviser : le retirer de la liste'
                          }
                        >
                          {c.ignored ? 'Rétablir' : 'Ignorer'}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="py-12 text-center text-muted">
                {view === 'todo'
                  ? data.lastSyncAt
                    ? 'Tous les serveurs du groupe ont leur agent.'
                    : 'Première synchronisation en cours.'
                  : 'Aucun appareil ignoré.'}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Pastille du menu : nombre d'appareils à équiper. */
export function ToDeployCount() {
  const { data } = usePoll<TvStatus>('/api/teamviewer', 120_000);
  const n = data?.toDeploy?.filter((c) => !c.ignored).length ?? 0;
  if (!n) return null;
  return <span className="ml-1.5 rounded-full bg-warn/15 px-1.5 py-px text-[11px] font-semibold tabular-nums text-warn">{n}</span>;
}
