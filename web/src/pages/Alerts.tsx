import { useState } from 'react';
import { Link } from 'react-router';
import { api, type AlertRow } from '../api';
import { PageHeader, Pill, Segmented } from '../components/ui';
import { ago, dateTime } from '../format';
import { usePoll } from '../hooks';

export default function Alerts() {
  const [state, setState] = useState<'open' | 'all'>('open');
  const { data, reload } = usePoll<AlertRow[]>(`/api/alerts?state=${state}`);

  const ack = async (id: number) => {
    await api(`/api/alerts/${id}/ack`, { method: 'POST' });
    void reload();
  };

  const rows = data ?? [];
  const open = rows.filter((a) => !a.closed_at);
  const crit = open.filter((a) => a.severity === 'critical').length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alertes"
        subtitle={
          state === 'open' ? (
            <>
              <b className={crit ? 'text-crit' : 'text-text'}>{crit}</b> critique(s) et <b className="text-warn">{open.length - crit}</b> avertissement(s) en cours
            </>
          ) : (
            'Historique des alertes'
          )
        }
        right={
          <Segmented
            value={state}
            onChange={setState}
            options={[
              ['open', 'En cours'],
              ['all', 'Historique'],
            ]}
          />
        }
      />
      <div className="glass animate-rise overflow-x-auto rounded-xl">
        <table>
          <thead>
            <tr>
              <th>Gravité</th>
              <th>Serveur</th>
              <th>Message</th>
              <th>Ouverte</th>
              <th>{state === 'all' ? 'Fermée' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const color = a.closed_at ? 'var(--color-off)' : a.severity === 'critical' ? 'var(--color-crit)' : 'var(--color-warn)';
              return (
                <tr key={a.id} className={`group ${a.acked && !a.closed_at ? 'opacity-60' : ''}`}>
                  <td className="relative">
                    <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full" style={{ background: color, boxShadow: a.closed_at ? undefined : `0 0 8px ${color}` }} />
                    <Pill tone={a.closed_at ? 'muted' : a.severity === 'critical' ? 'crit' : 'warn'}>{a.severity === 'critical' ? 'Critique' : 'Alerte'}</Pill>
                  </td>
                  <td className="max-w-[300px]">
                    <Link to={`/serveurs/${a.server_id}`} className="block truncate font-medium transition group-hover:text-accent" title={a.server_name}>
                      {a.server_name}
                    </Link>
                    <div className="truncate text-[11px] text-muted">{a.client_name ?? 'non affecté'}</div>
                  </td>
                  <td className="min-w-[260px] whitespace-normal">{a.message}</td>
                  <td className="text-xs text-muted" title={dateTime(a.opened_at)}>
                    {ago(a.opened_at)}
                  </td>
                  <td>
                    {a.closed_at ? (
                      <span className="text-xs text-muted">{dateTime(a.closed_at)}</span>
                    ) : a.acked ? (
                      <span className="text-xs text-muted">prise en compte</span>
                    ) : (
                      <button
                        onClick={() => ack(a.id)}
                        className="rounded-md border border-accent/40 px-2 py-0.5 text-xs text-accent transition hover:bg-accent/10"
                      >
                        Prendre en compte
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data?.length === 0 && (
          <p className="py-12 text-center text-muted">{state === 'open' ? 'Aucune alerte en cours. Tout va bien.' : 'Aucune alerte.'}</p>
        )}
      </div>
    </div>
  );
}
