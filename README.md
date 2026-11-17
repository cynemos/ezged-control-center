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
- CPU, RAM, disques, durée depuis le démarrage, redémarrage en attente ;
- services `Apache2.4`, `EzGED`, `MySQL` ;
- réponse du serveur EzGED interne (port lu dans `instance.conf`) et, si configurée, de l'URL publique ;
- dernier dump dans `C:\nchp\save_dump` (âge, taille) ;
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
| Serveur EzGED ou page publique injoignable | critique |
| Disque ≥ 90 % / ≥ 95 % | alerte / critique |
| Dernier dump > 26 h / > 50 h, ou aucun dump | alerte / critique |
| Fichier en file depuis > 60 min | alerte |
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

## Installer l'agent sur un serveur

Depuis la page **Ajouter un serveur** de la console : copier le dossier `agent\` sur le serveur, puis en PowerShell administrateur :

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -ServerUrl https://ezged-cc.mondomaine.fr -EnrollKey <clé>
```

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
