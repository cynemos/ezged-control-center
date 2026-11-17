import { useState } from 'react';
import { Link } from 'react-router';
import { api, type AlertRow } from '../api';
import { Pill } from '../components/ui';
import { ago, dateTime } from '../format';
import { usePoll } from '../hooks';

export default function Alerts() {
  const [state, setState] = useState<'open' | 'all'>('open');
  const { data, reload } = usePoll<AlertRow[]>(`/api/alerts?state=${state}`);

  const ack = async (id: number) => {
    await api(`/api/alerts/${id}/ack`, { method: 'POST' });
    void reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {(['open', 'all'] as const).map((k) => (
          <button key={k} onClick={() => setState(k)} className={`rounded-md px-3 py-1.5 text-sm ${state === k ? 'bg-panel-2' : 'text-muted'}`}>
            {k === 'open' ? 'En cours' : 'Historique'}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table>
          <thead>
            <tr>
              <th>Gravité</th>
              <th>Client</th>
              <th>Serveur</th>
              <th>Message</th>
              <th>Ouverte</th>
              <th>{state === 'all' ? 'Fermée' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((a) => (
              <tr key={a.id} className={a.acked && !a.closed_at ? 'opacity-60' : ''}>
                <td>
                  <Pill tone={a.closed_at ? 'muted' : a.severity === 'critical' ? 'crit' : 'warn'}>{a.severity === 'critical' ? 'Critique' : 'Alerte'}</Pill>
                </td>
                <td className="text-muted">{a.client_name ?? '—'}</td>
                <td>
                  <Link to={`/serveurs/${a.server_id}`} className="text-accent hover:underline">
                    {a.server_name}
                  </Link>
                </td>
                <td className="whitespace-normal">{a.message}</td>
                <td className="text-muted" title={dateTime(a.opened_at)}>
                  {ago(a.opened_at)}
                </td>
                <td>
                  {a.closed_at ? (
                    <span className="text-muted">{dateTime(a.closed_at)}</span>
                  ) : a.acked ? (
                    <span className="text-xs text-muted">prise en compte</span>
                  ) : (
                    <button onClick={() => ack(a.id)} className="text-xs text-accent hover:underline">
                      Prendre en compte
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-muted">
                  {state === 'open' ? 'Aucune alerte en cours.' : 'Aucune alerte.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
