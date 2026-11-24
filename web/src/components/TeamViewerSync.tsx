import { useState } from 'react';
import { api } from '../api';
import { dateTime } from '../format';
import { usePoll } from '../hooks';
import { Button, Card } from './ui';

interface Status {
  enabled: boolean;
  lastSyncAt: string | null;
  error: string | null;
  warning: string | null;
  devices: number;
  matched: number;
  updated: number;
  unmatched: string[];
}

// Noms TeamViewer : les fiches sans nom ni client les reprennent du compte TeamViewer.
export default function TeamViewerSync() {
  const { data, reload } = usePoll<Status>('/api/teamviewer', 60_000);
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  async function sync() {
    setBusy(true);
    try {
      await api('/api/teamviewer/sync', { method: 'POST' });
    } finally {
      setBusy(false);
      void reload();
    }
  }

  return (
    <Card
      title="Noms TeamViewer"
      right={
        data.enabled ? (
          <Button onClick={sync} disabled={busy}>
            {busy ? 'Synchronisation…' : 'Synchroniser'}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-2 text-sm">
        <p className="text-muted">
          Chaque serveur est retrouvé par son ID TeamViewer. Une fiche sans nom prend le nom de l'appareil dans TeamViewer, et une fiche sans client
          prend le client déduit de ce nom (« 4.1 - MAIRIE DE UR - new » donne « MAIRIE DE UR »). Ce qui est saisi dans la console n'est jamais écrasé.
          Synchronisation tous les quarts d'heure.
        </p>
        {!data.enabled ? (
          <p>
            Désactivé : ajouter <code>TEAMVIEWER_API_TOKEN</code> dans le <code>.env</code> de la console (jeton de script TeamViewer, droit de
            lecture « Ordinateurs et contacts », « Gestion des groupes » et « Gestion des appareils » uniquement), puis redémarrer le service.
          </p>
        ) : data.error ? (
          <p className="text-crit">{data.error}</p>
        ) : data.lastSyncAt ? (
          <p>
            Dernière synchronisation {dateTime(data.lastSyncAt)} : {data.devices} appareil(s) TeamViewer, {data.matched} serveur(s) reconnu(s),{' '}
            {data.updated} fiche(s) complétée(s).
            {data.unmatched.length > 0 && (
              <span className="mt-1 block text-muted">Absents des listes TeamViewer lues : {data.unmatched.join(', ')}.</span>
            )}
            {data.warning && <span className="mt-1 block text-warn">{data.warning}</span>}
          </p>
        ) : (
          <p className="text-muted">Première synchronisation en cours.</p>
        )}
      </div>
    </Card>
  );
}
