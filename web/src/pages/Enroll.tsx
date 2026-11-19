import { useState } from 'react';
import { Card } from '../components/ui';
import DeployTokens from '../components/DeployTokens';
import { usePoll } from '../hooks';

export default function Enroll() {
  const { data } = usePoll<{ publicUrl: string; enrollKey: string }>('/api/enroll-info', 600_000);
  const [show, setShow] = useState(false);
  if (!data) return null;

  const key = show ? data.enrollKey : '•'.repeat(12);
  const cmd = `powershell -ExecutionPolicy Bypass -File .\\install-agent.ps1 -ServerUrl ${data.publicUrl} -EnrollKey ${data.enrollKey}`;

  return (
    <div className="max-w-3xl space-y-4">
      <Card title="Installer l'agent sur un serveur EzGED">
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            Copier le dossier <code className="text-accent">agent\</code> (3 scripts) sur le serveur, par exemple dans <code>C:\Temp\ezgedcc</code>.
          </li>
          <li>
            Ouvrir PowerShell <strong>en administrateur</strong> dans ce dossier et lancer :
            <pre className="mt-2 overflow-x-auto rounded bg-panel-2 p-3 text-xs">
              {`powershell -ExecutionPolicy Bypass -File .\\install-agent.ps1 -ServerUrl ${data.publicUrl} -EnrollKey ${key}`}
            </pre>
            <div className="mt-2 flex gap-3 text-xs">
              <button className="text-accent" onClick={() => setShow(!show)}>
                {show ? 'Masquer la clé' : 'Afficher la clé'}
              </button>
              <button className="text-accent" onClick={() => navigator.clipboard.writeText(cmd)}>
                Copier la commande
              </button>
            </div>
          </li>
          <li>Le serveur apparaît dans le parc sous une minute. Affectez-lui ensuite un client depuis sa fiche.</li>
        </ol>
      </Card>
      <DeployTokens />
      <Card title="Options de l'installeur">
        <ul className="space-y-1.5 text-sm">
          <li><code>-NchpRoot D:\nchp</code> : racine EzGED si elle n'est pas dans <code>C:\nchp</code>.</li>
          <li><code>-RustDeskId 123456789</code> : ID RustDesk (détecté automatiquement si RustDesk est installé).</li>
          <li><code>-DbUser ezgedcc</code> : compte MariaDB de supervision, sans droit sur les données. Le mot de passe est demandé.</li>
          <li><code>-Reenroll</code> : force un nouvel enregistrement (crée une nouvelle fiche).</li>
        </ul>
        <p className="mt-3 text-xs text-muted">
          Compte MariaDB conseillé : <code>CREATE USER 'ezgedcc'@'localhost' IDENTIFIED BY '…';</code> sans aucun GRANT. Il suffit pour lire les compteurs
          globaux (connexions, requêtes lentes).
        </p>
      </Card>
    </div>
  );
}
