import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { dateTime } from '../format';

interface Outage {
  id: string;
  name: string;
  client: string | null;
  since: string;
  lastSeen: string | null;
  online: boolean;
  acked: boolean;
  services: { alertId: number; name: string; message: string; since: string }[];
}

const LABEL: Record<string, string> = { 'Apache2.4': 'Apache', EzGED: 'EzGED', MySQL: 'MySQL' };
const TITLE = document.title;
const SEEN_KEY = 'ezgedcc:ged-outages-notified';

function since(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  return `${Math.round(min / 1440)} j`;
}

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/**
 * Bandeau rouge affiché sur toutes les pages tant qu'Apache, EzGED ou MySQL est arrêté sur un serveur :
 * la GED n'est alors plus utilisable. Rafraîchi toutes les 20 s, même onglet en arrière-plan, pour
 * l'onglet du navigateur et la notification de bureau.
 */
export function GedOutageBanner() {
  const [outages, setOutages] = useState<Outage[]>([]);
  const [channels, setChannels] = useState<string[] | null>(null);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const seen = useRef(readSeen());

  const load = useCallback(async () => {
    try {
      const r = await api<{ outages: Outage[]; notifications: string[] }>('/api/outages');
      setOutages(r.outages);
      setChannels(r.notifications);
    } catch {
      /* déconnexion ou réseau : on garde le dernier état */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  // Onglet du navigateur et notification de bureau pour chaque nouveau serveur touché.
  useEffect(() => {
    document.title = outages.length ? `⛔ GED HS (${outages.length}) · ${TITLE}` : TITLE;
    const current = new Set(outages.map((o) => o.id));
    for (const o of outages) {
      if (seen.current.has(o.id)) continue;
      seen.current.add(o.id);
      if (perm === 'granted') {
        const n = new Notification(`GED hors service – ${o.client ? `${o.client} / ` : ''}${o.name}`, {
          body: o.services.map((s) => s.message).join('\n'),
          tag: `ged-${o.id}`,
          requireInteraction: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      }
    }
    // Serveur rétabli : une nouvelle panne sera de nouveau notifiée.
    for (const id of [...seen.current]) if (!current.has(id)) seen.current.delete(id);
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen.current]));
    } catch {
      /* stockage indisponible : sans conséquence */
    }
  }, [outages, perm]);

  useEffect(() => () => void (document.title = TITLE), []);

  if (!outages.length) return null;

  const ack = async (o: Outage) => {
    await Promise.all(o.services.map((s) => api(`/api/alerts/${s.alertId}/ack`, { method: 'POST' })));
    await load();
  };
  const askPerm = async () => setPerm(await Notification.requestPermission());

  return (
    <div role="alert" className="border-b border-crit/60 bg-crit/15">
      <div className="mx-auto max-w-[1500px] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="relative inline-flex h-3 w-3">
            <span className="absolute inset-0 animate-ping rounded-full bg-crit opacity-75" />
            <span className="relative h-3 w-3 rounded-full bg-crit" />
          </span>
          <strong className="text-base font-semibold text-crit">
            GED hors service sur {outages.length} serveur{outages.length > 1 ? 's' : ''}
          </strong>
          <span className="text-sm text-text/80">Apache, EzGED ou MySQL arrêté : les utilisateurs ne peuvent plus travailler.</span>
          <span className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted">
            {perm === 'default' && (
              <button onClick={askPerm} className="rounded-md border border-line px-2 py-1 hover:text-text">
                Activer l'alerte sur le bureau
              </button>
            )}
            {channels && !channels.length && <span>Aucun e-mail ni webhook configuré : seule cette console prévient.</span>}
          </span>
        </div>
        <ul className="mt-2 grid gap-1.5">
          {outages.map((o) => (
            <li
              key={o.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-crit/40 bg-bg/60 px-3 py-2 text-sm ${o.acked ? 'opacity-70' : ''}`}
            >
              <Link to={`/serveurs/${o.id}`} className="font-semibold hover:underline">
                {o.client && <span className="text-muted">{o.client} / </span>}
                {o.name}
              </Link>
              {o.services.map((s) => (
                <span key={s.name} className="rounded-md bg-crit/20 px-2 py-0.5 text-xs font-semibold text-crit" title={s.message}>
                  {LABEL[s.name] ?? s.name} : {s.message.replace(/^.*?:\s*/, '')}
                </span>
              ))}
              <span className="text-xs text-muted" title={dateTime(o.since)}>
                depuis <strong className="text-text">{since(o.since)}</strong> ({dateTime(o.since)})
              </span>
              {!o.online && <span className="text-xs text-warn">agent muet : état peut-être dépassé</span>}
              <span className="ml-auto">
                {o.acked ? (
                  <span className="text-xs text-muted">Pris en charge (rappels coupés)</span>
                ) : (
                  <button
                    onClick={() => void ack(o)}
                    className="rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:text-text"
                    title="Acquitte l'alerte : plus de rappel horaire. Le bandeau reste jusqu'au redémarrage du service."
                  >
                    Je m'en occupe
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
