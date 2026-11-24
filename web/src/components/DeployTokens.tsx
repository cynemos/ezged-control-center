import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { dateTime } from '../format';
import { usePoll } from '../hooks';
import { Button, Card, Pill } from './ui';

interface DeployToken {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
  servers: { id: string; name: string }[];
}

function state(t: DeployToken): { tone: 'ok' | 'muted' | 'crit'; label: string } {
  if (t.revokedAt) return { tone: 'crit', label: 'révoqué' };
  if (new Date(t.expiresAt).getTime() <= Date.now()) return { tone: 'muted', label: 'expiré' };
  if (t.uses >= t.maxUses) return { tone: 'muted', label: 'épuisé' };
  return { tone: 'ok', label: 'actif' };
}

// Déploiement de l'agent par un outil tiers (TeamViewer Remote Management, GPO...) :
// la console génère un script qui ne contient qu'un jeton à durée et usages limités.
export default function DeployTokens() {
  const { data, reload } = usePoll<DeployToken[]>('/api/deploy-tokens', 60_000);
  const [label, setLabel] = useState('TeamViewer EzGED');
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState(100);
  const [script, setScript] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      const r = await api<{ script: string }>('/api/deploy-tokens', { method: 'POST', json: { label, days, maxUses } });
      setScript(r.script);
      setCopied(false);
      void reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revoke(t: DeployToken) {
    if (!confirm(`Révoquer le jeton « ${t.label} » ? Le script qui le contient ne pourra plus installer d'agent.`)) return;
    await api(`/api/deploy-tokens/${t.id}/revoke`, { method: 'POST' });
    void reload();
  }

  return (
    <Card title="Déploiement par script (TeamViewer, GPO...)">
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Génère un script PowerShell à enregistrer dans TeamViewer (Remote Management, Scripts : type PowerShell, « Exécuter en tant
          qu'administrateur »), puis à lancer sur un groupe d'appareils. Il télécharge l'installeur depuis la console et enregistre le
          serveur avec un jeton limité en durée et en nombre d'installations. Relancé sur un serveur déjà équipé, il met l'agent à jour sans
          consommer d'installation.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs text-muted">Libellé</span>
            <input className="w-56" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Validité (jours, max 30)</span>
            <input className="w-24" type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Installations (max 500)</span>
            <input className="w-24" type="number" min={1} max={500} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} />
          </label>
          <Button variant="primary" onClick={create}>
            Générer le script
          </Button>
        </div>
        {error && <p className="text-crit">{error}</p>}

        {script && (
          <div className="space-y-2 rounded-xl border border-warn/50 bg-warn/5 p-3">
            <p className="text-xs text-warn">
              Script affiché une seule fois : la console ne garde que l'empreinte du jeton. Tant qu'il est actif, ce script peut enregistrer
              un serveur : ne le diffusez pas et révoquez le jeton une fois le déploiement terminé.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-line bg-black/30 p-3 text-xs">{script}</pre>
            <div className="flex gap-3 text-xs">
              <button className="text-accent" onClick={() => navigator.clipboard.writeText(script).then(() => setCopied(true))}>
                {copied ? 'Copié' : 'Copier le script'}
              </button>
              <button className="text-muted" onClick={() => setScript(null)}>
                Masquer
              </button>
            </div>
          </div>
        )}

        {data && data.length > 0 && (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 pr-2 font-normal">Jeton</th>
                  <th className="py-1 pr-2 font-normal">Expire</th>
                  <th className="py-1 pr-2 font-normal">Installations</th>
                  <th className="py-1 pr-2 font-normal">Serveurs</th>
                  <th className="py-1 font-normal" />
                </tr>
              </thead>
              <tbody>
                {data.map((t) => {
                  const st = state(t);
                  return (
                    <tr key={t.id} className="border-t border-line align-top">
                      <td className="py-1.5 pr-2">
                        <div>{t.label}</div>
                        <div className="text-muted">créé {dateTime(t.createdAt)}</div>
                      </td>
                      <td className="py-1.5 pr-2">{dateTime(t.expiresAt)}</td>
                      <td className="py-1.5 pr-2">
                        {t.uses} / {t.maxUses}
                      </td>
                      <td className="min-w-[220px] whitespace-normal py-1.5 pr-2 leading-relaxed">
                        {t.servers.length
                          ? t.servers.map((s, i) => (
                              <span key={s.id}>
                                {i > 0 && ', '}
                                <Link className="text-accent" to={`/serveurs/${s.id}`}>
                                  {s.name}
                                </Link>
                              </span>
                            ))
                          : '—'}
                      </td>
                      <td className="py-1.5 text-right">
                        <span className="inline-flex items-center gap-2">
                          <Pill tone={st.tone}>{st.label}</Pill>
                          {st.label === 'actif' && (
                            <button className="text-crit" onClick={() => revoke(t)}>
                              Révoquer
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
