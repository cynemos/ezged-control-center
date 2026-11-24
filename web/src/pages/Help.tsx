import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { PageHeader, Pill } from '../components/ui';

const SECTIONS = [
  ['demarrage', 'Démarrage rapide'],
  ['pages', 'Les pages'],
  ['voyants', 'Voyants de santé'],
  ['alertes', 'Alertes et seuils'],
  ['deploiement', 'Déployer l’agent'],
  ['teamviewer', 'TeamViewer'],
  ['mises-a-jour', 'Mises à jour'],
  ['depannage', 'Dépannage'],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="glass scroll-mt-24 animate-rise rounded-xl p-5">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <span className="h-4 w-1 rounded-full bg-gradient-to-b from-accent to-accent-2" />
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-text/90">{children}</div>
    </section>
  );
}

function Cmd({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg border border-line bg-black/30 p-3 text-xs">{children}</pre>;
}

const LIGHTS: [string, string][] = [
  ['Agent', 'L’agent ne remonte plus (serveur hors ligne, tâche planifiée arrêtée), collecte trop lente ou en erreur.'],
  ['Système', 'Processeur, mémoire ou disque saturés, ou disque qui sera plein d’après la tendance des 7 derniers jours.'],
  ['Matériel', 'Journal Windows : erreurs disque, NTFS, écran bleu, arrêt inattendu, état SMART dégradé.'],
  ['Services', 'Apache2.4, EzGED ou MySQL arrêtés ou redémarrés récemment, MariaDB injoignable, erreurs dans ses journaux.'],
  ['Web', 'Le démon EzGED ou le site Apache ne répond pas, ou renvoie une erreur.'],
  ['Files', 'Fichiers bloqués dans une file de traitement EzGED (OCR, import…) depuis plus d’une heure.'],
  ['Dump', 'Sauvegarde MariaDB absente, trop ancienne ou anormalement petite.'],
  ['Veeam', 'Sauvegarde Veeam en échec, trop ancienne ou service arrêté.'],
  ['SSL', 'Certificat Apache qui expire bientôt.'],
];

const THRESHOLDS: [string, string, string][] = [
  ['Disque', '≥ 90 %', '≥ 95 %'],
  ['Disque plein (tendance)', '< 30 jours', '< 7 jours'],
  ['Mémoire', '≥ 95 %', '—'],
  ['Processeur (moyenne 5 mesures)', '≥ 90 %', '—'],
  ['Dump MariaDB', '> 26 h', '> 50 h'],
  ['Dump plus petit que le précédent', '< 50 %', '—'],
  ['Veeam', '> 74 h', '> 98 h'],
  ['File de traitement', 'plus ancien > 1 h', '—'],
  ['Certificat SSL', '≤ 15 jours', '≤ 3 jours'],
  ['Agent sans nouvelles', '—', '> 5 min (hors ligne)'],
];

export default function Help() {
  return (
    <div className="space-y-5">
      <PageHeader title="Aide" subtitle="Utiliser la console, comprendre les voyants et les alertes, déployer et mettre à jour." />

      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="glass h-max rounded-xl p-3 text-sm lg:sticky lg:top-24">
          <ul className="space-y-0.5">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="block rounded-md px-2.5 py-1.5 text-muted transition hover:bg-white/[0.04] hover:text-text">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-5">
          <Section id="demarrage" title="Démarrage rapide">
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>
                Installer l’agent sur chaque serveur EzGED : page{' '}
                <Link to="/ajouter" className="text-accent">
                  Ajouter un serveur
                </Link>{' '}
                (à la main ou par script TeamViewer).
              </li>
              <li>
                Le serveur apparaît dans le Parc sous une minute, avec le nom et le client repris de TeamViewer (ou à saisir sur sa fiche).
              </li>
              <li>
                Suivre ce qui reste à équiper dans{' '}
                <Link to="/a-deployer" className="text-accent">
                  Agents à déployer
                </Link>
                .
              </li>
              <li>
                Surveiller le Parc et les Alertes ; les notifications partent par e-mail ou webhook si la console est configurée pour.
              </li>
            </ol>
          </Section>

          <Section id="pages" title="Les pages">
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[160px_1fr]">
              <dt className="font-medium">Parc</dt>
              <dd className="text-muted">
                Vue d’ensemble : santé globale, tuiles ou tableau, filtres par état et par client, mode plein écran pour un mur de
                supervision.
              </dd>
              <dt className="font-medium">Fiche serveur</dt>
              <dd className="text-muted">
                Détail d’un serveur : système, versions, services, disques, sauvegardes, files, certificats, historique CPU / RAM / disque,
                prise en main TeamViewer ou RustDesk.
              </dd>
              <dt className="font-medium">Versions</dt>
              <dd className="text-muted">
                Versions EzGED, Apache, PHP, MariaDB et agent ; systèmes d’exploitation avec fin de support Microsoft et état des mises à
                jour Windows.
              </dd>
              <dt className="font-medium">Alertes</dt>
              <dd className="text-muted">
                Alertes en cours et historique. « Prendre en compte » grise l’alerte sans la fermer ; elle se ferme seule une fois le
                problème réglé.
              </dd>
              <dt className="font-medium">Agents à déployer</dt>
              <dd className="text-muted">
                Appareils du groupe TeamViewer EzGED sans agent. « Ignorer » retire un appareil qui n’est pas à superviser.
              </dd>
              <dt className="font-medium">Ajouter un serveur</dt>
              <dd className="text-muted">
                Commande d’installation, jetons de déploiement par script, état de la synchronisation TeamViewer.
              </dd>
            </dl>
          </Section>

          <Section id="voyants" title="Voyants de santé">
            <p className="text-muted">
              Chaque serveur affiche neuf voyants. Un voyant prend la couleur de l’alerte la plus grave de sa catégorie :{' '}
              <Pill tone="ok">OK</Pill> <Pill tone="warn">alerte</Pill> <Pill tone="crit">critique</Pill>{' '}
              <Pill tone="muted">sans objet</Pill>.
            </p>
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[110px_1fr]">
              {LIGHTS.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-medium">{k}</dt>
                  <dd className="text-muted">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section id="alertes" title="Alertes et seuils">
            <div className="overflow-x-auto rounded-lg border border-line">
              <table>
                <thead>
                  <tr>
                    <th>Contrôle</th>
                    <th>Alerte</th>
                    <th>Critique</th>
                  </tr>
                </thead>
                <tbody>
                  {THRESHOLDS.map(([k, w, c]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="text-warn">{w}</td>
                      <td className="text-crit">{c}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-muted">
              Les services Apache2.4, EzGED et MySQL arrêtés déclenchent une alerte critique. Une alerte s’ouvre au premier dépassement et
              se ferme d’elle-même quand la mesure revient à la normale.
            </p>
          </Section>

          <Section id="deploiement" title="Déployer l’agent">
            <p>
              <b>À la main</b> : copier le dossier <code>agent\</code> sur le serveur, puis lancer la commande affichée dans{' '}
              <Link to="/ajouter" className="text-accent">
                Ajouter un serveur
              </Link>{' '}
              dans PowerShell en administrateur.
            </p>
            <p>
              <b>Par script</b> : générer un script dans « Déploiement par script », l’enregistrer dans TeamViewer (type PowerShell,
              exécuter en tant qu’administrateur), puis le lancer serveur par serveur depuis une session (Actions, Scripts). Le jeton du
              script est limité en durée et en nombre d’installations : le révoquer une fois le déploiement terminé.
            </p>
            <p className="text-muted">Relancé sur un serveur déjà équipé, le script met l’agent à jour sans créer de nouvelle fiche.</p>
          </Section>

          <Section id="teamviewer" title="TeamViewer">
            <p>
              Avec <code>TEAMVIEWER_API_TOKEN</code> dans le <code>.env</code>, la console lit le compte TeamViewer tous les quarts d’heure,
              et une minute environ après l’installation d’un nouvel agent. Le bouton « Synchroniser » la lance tout de suite.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>Nom</b> : suit le nom TeamViewer, renommages compris. Un nom modifié sur la fiche est figé ; le vider fait reprendre
                le nom TeamViewer.
              </li>
              <li>
                <b>Client</b> : déduit du nom TeamViewer pour les fiches sans client ; un client saisi n’est jamais écrasé.
              </li>
              <li>
                <b>Suppression</b> : un appareil supprimé de TeamViewer voit sa fiche supprimée une heure plus tard, si son agent ne
                remonte plus. Pas plus de 3 suppressions d’un coup, et aucune si une liste TeamViewer n’a pas pu être lue.
              </li>
            </ul>
            <p>Droits de lecture à donner au jeton de script :</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>« Ordinateurs et contacts » : noms des appareils ;</li>
              <li>« Gestion des appareils » : appareils gérés ;</li>
              <li>« Gestion des groupes » ou « Groupes d’appareils » : groupe EzGED pour la page Agents à déployer.</li>
            </ul>
            <p className="text-muted">
              Groupe suivi : <code>TEAMVIEWER_GROUPS=EzGED</code> (plusieurs groupes séparés par des virgules).
            </p>
          </Section>

          <Section id="mises-a-jour" title="Mises à jour">
            <p>
              <b>Console</b> : sur le serveur qui l’héberge, en PowerShell administrateur. Le script télécharge la dernière version publiée,
              vérifie son empreinte et redémarre la console.
            </p>
            <Cmd>{'powershell -ExecutionPolicy Bypass -File C:\\EzGedControlCenter\\update-console.ps1'}</Cmd>
            <p>
              <b>Agents</b> : avec <code>AGENT_AUTO_UPDATE=1</code> dans le <code>.env</code>, chaque agent se met à jour seul à la version
              embarquée dans la console. Sinon, relancer le script de déploiement sur le serveur.
            </p>
            <p className="text-muted">Après une mise à jour de la console, recharger la page avec Ctrl+F5.</p>
          </Section>

          <Section id="depannage" title="Dépannage">
            <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-[200px_1fr]">
              <dt className="font-medium">Serveur « Hors ligne »</dt>
              <dd className="text-muted">
                Plus de rapport depuis 5 minutes : serveur éteint, réseau coupé, ou tâche planifiée « EzGed ControlCenter Agent » arrêtée
                sur le serveur.
              </dd>
              <dt className="font-medium">Serveur « En attente »</dt>
              <dd className="text-muted">
                Enregistré mais aucun rapport reçu : vérifier que la tâche planifiée tourne et que le serveur joint l’adresse de la console.
              </dd>
              <dt className="font-medium">Agent refusé (401)</dt>
              <dd className="text-muted">
                Jeton de l’agent refusé : fiche supprimée, ou reprise par un serveur cloné (même MachineGuid) avant la v0.8.1. Relancer
                l’installeur sur le serveur : il vérifie son jeton et se réenregistre.
              </dd>
              <dt className="font-medium">Installation en échec</dt>
              <dd className="text-muted">
                La fenêtre du script TeamViewer reste ouverte deux minutes ; le détail est dans{' '}
                <code>C:\ProgramData\EzGedControlCenter\install.log</code>.
              </dd>
              <dt className="font-medium">Section « Disponible à partir de l’agent x »</dt>
              <dd className="text-muted">L’agent du serveur est trop ancien : le mettre à jour.</dd>
              <dt className="font-medium">Agents à déployer vide</dt>
              <dd className="text-muted">
                Lire le message affiché sur la page : il manque en général un droit de lecture sur le jeton TeamViewer.
              </dd>
              <dt className="font-medium">Page vide ou ancienne</dt>
              <dd className="text-muted">Recharger avec Ctrl+F5 ; vérifier la version dans le pied de page.</dd>
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}
