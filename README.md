# EzGed ControlCenter – supervision du parc EzGED

Console web pour suivre l'état, les performances et les versions des serveurs EzGED installés chez les clients.

```
[Serveur EzGED client] --HTTPS sortant--> [Console EzGed ControlCenter (VPS)] <--- navigateur
  agent PowerShell                         API Node/TS + PostgreSQL
  (tâche planifiée, 1/min)                 interface React, alertes
```

L'agent se connecte uniquement **en sortie** (HTTPS). Aucun port à ouvrir chez les clients.

## Contenu

| Dossier | Rôle |
|---|---|
| `agent/` | `ezged-cc-agent.ps1` (collecte), `install-agent.ps1`, `uninstall-agent.ps1` |
| `server/` | API Fastify + TypeScript, moteur d'alertes, notifications |
| `web/` | Interface React (parc, fiche serveur, versions, alertes, ajout de serveur) |
| `deploy/`, `Dockerfile`, `docker-compose.yml` | Déploiement VPS avec PostgreSQL et Caddy (HTTPS automatique) |

## Ce que l'agent remonte

Chaque minute :
- CPU, RAM, disques, durée depuis le démarrage ;
- services `Apache2.4`, `EzGED`, `MySQL` et leurs processus (CPU, mémoire, handles, threads, date de démarrage) ;
- réponse du démon EzGED interne (port lu dans `instance.conf`, 8080 par défaut, relayé par Apache) ;
- accès web Apache, testé en local sur chaque port `Listen` de sa configuration (80 ou 8000, 443 ou 4430 en SSL, certificat non vérifié) ;
- si configurée, réponse de l'URL publique ;
- dernier dump dans `C:\nchp\save_dump` (âge, taille) ;
- Veeam Agent for Windows s'il est installé : service, version, résultat de la dernière tâche et date de la dernière sauvegarde réussie (journal d'événements `Veeam Agent`) ;
- toutes les 5 à 15 min (résultat gardé en cache et renvoyé entre deux calculs) : dernier dump, Veeam, redémarrage en attente, liste des ports Apache ;
- santé de l'agent : durée de collecte, collectes en échec, versions de PowerShell et .NET ;
- files `enqueued`, `wait`, `ocr`, `convd`, `pdf2txt`, `ps2pdf` (nombre de fichiers, âge du plus ancien) ;
- compteurs MariaDB si un compte de supervision est configuré.

Toutes les heures (inventaire) :
- Windows (édition, build), versions EzGED (`revision.txt`), Apache, PHP, MariaDB ;
- dépôt EzGED, nom et taille de la base ;
- mises à jour Windows en attente, dernier correctif installé ;
- certificats SSL déclarés dans la configuration Apache ;
- matériel.

L'agent **ne lit jamais** les mots de passe de `instance.conf` ni les clés de `etc\nchp\ezged\`.

## Alertes

| Règle | Gravité |
|---|---|
| Aucun rapport depuis 5 min | critique |
| Service Apache / EzGED / MySQL arrêté | critique |
| Démon EzGED, accès web Apache ou page publique injoignable | critique |
| Disque ≥ 90 % / ≥ 95 % | alerte / critique |
| Dernier dump > 26 h / > 50 h, ou aucun dump | alerte / critique |
| Veeam : service arrêté ou dernière tâche en échec | critique |
| Veeam : dernière tâche en avertissement | alerte |
| Veeam : dernière réussite > 74 h / > 98 h (marge pour le week-end) | alerte / critique |
| Fichier en file depuis > 60 min | alerte |
| Service redémarré depuis < 15 min (hors redémarrage du serveur) | alerte |
| Agent : collecte en échec ou plus lente que 45 s | alerte |
| RAM ≥ 95 %, CPU moyen ≥ 90 % sur 5 min | alerte |
| Certificat expirant < 15 j / < 3 j | alerte / critique |
| Connexion MariaDB impossible | critique |

Seuils dans `server/src/alerts.ts`. Notifications par webhook, Telegram et e-mail (`.env`), à l'ouverture, à l'aggravation et à la résolution.

## Développement (Windows, sans Docker)

```powershell
cd server
copy ..\.env.example .env      # remplir ADMIN_PASSWORD, SESSION_SECRET, ENROLL_KEY
npm install
npm run dev                    # API sur http://localhost:3000, base PGlite dans server/data/
```

```powershell
cd web
npm install
npm run dev                    # interface sur http://localhost:5173
```

Tester l'agent sans rien envoyer :

```powershell
powershell -ExecutionPolicy Bypass -File agent\ezged-cc-agent.ps1 -ConfigPath C:\chemin\config.json -DryRun -ForceInventory
```

## Production

1. VPS Linux avec Docker, nom de domaine pointant dessus, ports 80/443 ouverts.
2. `cp .env.example .env` puis remplir les secrets et `EZGEDCC_DOMAIN`.
3. `docker compose up -d --build`.
4. Double authentification : `docker compose exec app node dist/tools/totp-new.js`, coller le secret dans `ADMIN_TOTP_SECRET`, puis `docker compose up -d`.

## Production sur Windows avec Tailscale Funnel (sans NAT)

Pour héberger la console sur un serveur Windows sans redirection de port : Tailscale Funnel publie la console en HTTPS sous un chemin, par exemple `https://srv-papercut.tailfdec83.ts.net/ezgedcc/`, à côté des autres applications déjà publiées.

1. Sur le poste de développement : `powershell -ExecutionPolicy Bypass -File deploy\windows\build-package.ps1`, qui produit `dist-package\ezgedcc-console.zip`.
2. Copier le zip sur le serveur et l'extraire.
3. En PowerShell administrateur, dans le dossier extrait : `powershell -ExecutionPolicy Bypass -File .\install-console.ps1`.

Le script installe un Node.js portable (empreinte vérifiée) dans `C:\EzGedControlCenter\node`, génère les secrets, crée la tâche planifiée `EzGed ControlCenter Console` (SYSTEM, au démarrage, relance automatique), fait écouter la console sur `127.0.0.1:8797` uniquement et ajoute `tailscale funnel --set-path /ezgedcc`. Il affiche l'adresse et le mot de passe administrateur une seule fois. Relancer le même script pour une mise à jour : `.env` et les données sont conservés.

Options : `-Port`, `-BasePath`, `-InstallDir`, `-NodeVersion`, `-SkipFunnel`.

Depuis le serveur lui-même, l'adresse `ts.net` pointe sur sa propre IP Tailscale : si un autre logiciel écoute sur le port 443 (PaperCut sur SRV-PAPERCUT), c'est lui qui répond (404 Jetty). Sur le serveur, utiliser `http://localhost:8797/ezgedcc/` ; ailleurs, l'adresse publique.

La variable `BASE_PATH` permet de servir la console sous n'importe quel préfixe ; l'interface et l'API s'adaptent toutes seules.

## Vue du parc

La page **Parc** affiche une tuile par serveur (ou un tableau, au choix) : bandeau de couleur selon l'état, CPU/RAM/disque, âge du dump et de la sauvegarde Veeam, version EzGED, et des voyants par catégorie (Agent, Système, Services, Web, Files, Dump, Veeam, SSL). Un voyant gris signifie « non surveillé sur ce serveur ». Le bouton **Plein écran** sert de mur de supervision ; la page se rafraîchit toute seule.

## Installer l'agent sur un serveur

Systèmes pris en charge : Windows 10, Server 2008 R2 SP1, 2012/2012 R2, 2016, 2019, 2022, 2025. Prérequis : PowerShell 3.0 et .NET 4.5 minimum (4.8 conseillé). Server 2012 et ultérieurs les ont d'origine ; un 2008 R2 en PowerShell 2.0 doit recevoir WMF 3.0 (KB2506143) ou 5.1, ce qui impose un redémarrage. L'installeur vérifie ces points, active TLS 1.2 dans le registre si nécessaire (2008 R2 / 2012, un redémarrage peut être requis ; `-SkipTlsFix` pour ne rien toucher), teste la connexion à la console avant toute modification, puis crée la tâche planifiée avec `schtasks` (compatible 2008 R2) et attend le premier rapport.

Depuis la page **Ajouter un serveur** de la console : copier le dossier `agent\` sur le serveur, puis en PowerShell administrateur :

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -ServerUrl https://ezged-cc.mondomaine.fr -EnrollKey <clé>
```

Mise à jour des agents : avec `AGENT_AUTO_UPDATE=1` dans le `.env` de la console, chaque agent plus ancien télécharge le script embarqué par la console, vérifie son empreinte SHA256 et sa syntaxe, puis se remplace ; la nouvelle version tourne à la minute suivante. Activer cette option donne à la console le pouvoir d'exécuter du code en SYSTEM sur tout le parc : la protéger en conséquence (mot de passe fort, double authentification). `-NoAutoUpdate` à l'installation refuse ces mises à jour sur un serveur.

L'installeur crée `C:\ProgramData\EzGedControlCenter` (accès SYSTEM et administrateurs uniquement), chiffre le jeton avec DPAPI et crée la tâche planifiée `EzGed ControlCenter Agent`.

Compte MariaDB de supervision conseillé, sans aucun droit sur les données :

```sql
CREATE USER 'ezgedcc'@'localhost' IDENTIFIED BY '...';
```

## Feuille de route

- Actions à distance depuis un catalogue fermé (redémarrer un service, lancer un dump), avec journal.
- Remontée des dernières erreurs des journaux Apache, MariaDB et EzGED.
- Plusieurs comptes utilisateurs.
- Rapport mensuel PDF par client.
