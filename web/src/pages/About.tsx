import { Link } from 'react-router';
import { Card, Kv, Logo, Pill } from '../components/ui';
import { ago, dateTime } from '../format';
import { usePoll } from '../hooks';

interface About {
  version: string;
  commit: string | null;
  builtAt: string | null;
  agentVersion: string | null;
  node: string;
  database: string;
  startedAt: string;
  publicUrl: string;
  teamviewer: boolean;
  agentAutoUpdate: boolean;
  servers: number;
  clients: number;
}

const REPO = 'https://github.com/cynemos/ezged-control-center';

export default function About() {
  const { data } = usePoll<About>('/api/about', 300_000);
  if (!data) return null;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <section className="glass relative animate-rise overflow-hidden rounded-2xl p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-accent/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-72 w-72 rounded-full bg-accent-2/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-6">
          <Logo size={72} />
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">
              EzGed <span className="text-gradient">ControlCenter</span>
            </h1>
            <p className="text-muted">
              Supervision du parc de serveurs EzGED : santé, sauvegardes, versions, alertes et déploiement de l'agent.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Pill tone="ok">Console {data.version}</Pill>
              {data.agentVersion && <Pill tone="muted">Agent {data.agentVersion}</Pill>}
              {data.commit && <span className="font-mono text-xs text-muted">commit {data.commit}</span>}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Version">
          <Kv
            rows={[
              ['Console', data.version],
              ['Construite le', data.builtAt ? dateTime(data.builtAt) : '—'],
              ['Commit', data.commit ?? '—'],
              ['Agent embarqué', data.agentVersion ?? 'introuvable'],
              ['Mise à jour auto. agent', data.agentAutoUpdate ? 'activée' : 'désactivée'],
            ]}
          />
        </Card>
        <Card title="Environnement">
          <Kv
            rows={[
              ['Démarrée', `${ago(data.startedAt)} (${dateTime(data.startedAt)})`],
              ['Node.js', data.node],
              ['Base de données', data.database],
              ['Adresse publique', data.publicUrl],
              ['Synchro TeamViewer', data.teamviewer ? 'active' : 'désactivée'],
            ]}
          />
        </Card>
        <Card title="Parc">
          <Kv
            rows={[
              ['Serveurs supervisés', data.servers],
              ['Clients', data.clients],
            ]}
          />
        </Card>
        <Card title="Auteur">
          <div className="space-y-3 text-sm">
            <p>
              Conçu et développé par <b>Cyril Nectoux</b> <span className="text-accent">@CYNEPROD</span>.
            </p>
            <div className="flex flex-wrap gap-3 text-xs">
              <a className="text-accent hover:underline" href={REPO} target="_blank" rel="noreferrer">
                Code source
              </a>
              <a className="text-accent hover:underline" href={`${REPO}/releases`} target="_blank" rel="noreferrer">
                Versions publiées
              </a>
              <Link className="text-accent hover:underline" to="/aide">
                Aide
              </Link>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
