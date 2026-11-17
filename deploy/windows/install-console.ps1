#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
  Installe (ou met a jour) la console EzGed ControlCenter sur un serveur Windows,
  publiee sur Internet par Tailscale Funnel sous un chemin (par defaut /ezgedcc).

  A lancer en PowerShell administrateur, depuis le dossier extrait du paquet :
    powershell -ExecutionPolicy Bypass -File .\install-console.ps1

  Relancer le meme script pour une mise a jour : la configuration (.env) et les donnees sont conservees.

  Ce que fait le script :
    - Node.js portable dans <InstallDir>\node (aucune installation systeme, empreinte SHA-256 verifiee) ;
    - application dans <InstallDir>\app, donnees dans <InstallDir>\data, journaux dans <InstallDir>\logs ;
    - secrets generes au premier lancement dans app\server\.env ;
    - tache planifiee "EzGed ControlCenter Console" (SYSTEM, au demarrage) ;
    - console a l'ecoute sur 127.0.0.1 uniquement, publiee par : tailscale funnel --set-path <BasePath>.
#>
param(
  [string]$InstallDir = 'C:\EzGedControlCenter',
  [int]$Port = 8797,
  [string]$BasePath = '/ezgedcc',
  [string]$NodeVersion = '24.15.0',
  [switch]$SkipFunnel
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$TaskName = 'EzGed ControlCenter Console'
$Src = $PSScriptRoot
$NodeDir = Join-Path $InstallDir 'node'
$AppDir = Join-Path $InstallDir 'app'
$ServerDir = Join-Path $AppDir 'server'
$EnvFile = Join-Path $ServerDir '.env'
$BasePath = '/' + $BasePath.Trim('/')

function Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function New-Secret([int]$Bytes) {
  $buf = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return [Convert]::ToBase64String($buf).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Find-Tailscale {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $p = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path $p) { return $p }
  throw 'tailscale.exe introuvable.'
}

function Stop-Console {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  # La tache ne termine pas toujours le processus Node enfant : on arrete celui de ce dossier.
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($NodeDir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains((Join-Path $InstallDir 'run-console.ps1')) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

if (-not (Test-Path (Join-Path $Src 'app\server\dist\index.js'))) {
  throw "Paquet incomplet : lancez ce script depuis le dossier extrait de ezgedcc-console.zip."
}

# ------------------------------------------------------------ 1. Arret de l'ancienne version
Step 'Arret de la console si elle tourne'
Stop-Console
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $owner = (Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
  throw "Le port $Port est deja utilise par '$owner'. Relancez avec -Port <autre port>."
}

# ------------------------------------------------------------ 2. Dossiers (SYSTEM et administrateurs uniquement)
Step "Dossier $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir, (Join-Path $InstallDir 'data'), (Join-Path $InstallDir 'logs') | Out-Null
& icacls $InstallDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

# ------------------------------------------------------------ 3. Node.js portable
$nodeExe = Join-Path $NodeDir 'node.exe'
$haveNode = (Test-Path $nodeExe) -and ((& $nodeExe -v) -eq "v$NodeVersion")
if (-not $haveNode) {
  Step "Telechargement de Node.js $NodeVersion"
  $name = "node-v$NodeVersion-win-x64"
  $base = "https://nodejs.org/dist/v$NodeVersion"
  $tmp = Join-Path $env:TEMP "ezgedcc-node-$NodeVersion"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "$name.zip"
  Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing
  $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $expected = ($sums -split "`n" | Where-Object { $_ -match "\s$name\.zip$" }) -replace '\s.*$', ''
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $actual -ne $expected.Trim().ToLower()) { throw "Empreinte SHA-256 de Node.js invalide ($actual)." }
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Move-Item (Join-Path $tmp $name) $NodeDir
  Remove-Item $tmp -Recurse -Force
}
Write-Host "Node.js $(& $nodeExe -v)"

# ------------------------------------------------------------ 4. Application
Step 'Copie de l''application'
$keepEnv = $null
if (Test-Path $EnvFile) { $keepEnv = [IO.File]::ReadAllText($EnvFile) }
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
Copy-Item (Join-Path $Src 'app') $AppDir -Recurse
Copy-Item (Join-Path $Src 'run-console.ps1') $InstallDir -Force
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'agent') | Out-Null
Copy-Item (Join-Path $Src 'agent\*.ps1') (Join-Path $InstallDir 'agent') -Force
if (Test-Path (Join-Path $Src 'VERSION.txt')) { Copy-Item (Join-Path $Src 'VERSION.txt') $InstallDir -Force }

Step 'Installation des dependances (npm ci)'
$env:Path = "$NodeDir;$env:Path"
Push-Location $ServerDir
try {
  & (Join-Path $NodeDir 'npm.cmd') ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci a echoue.' }
} finally { Pop-Location }

# ------------------------------------------------------------ 5. Adresse publique Tailscale
$ts = $null
$publicUrl = "http://127.0.0.1:$Port$BasePath"
if (-not $SkipFunnel) {
  $ts = Find-Tailscale
  $dns = ((& $ts status --json) | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
  if (-not $dns) { throw 'Nom DNS Tailscale introuvable : Tailscale est-il connecte ?' }
  $publicUrl = "https://$dns$BasePath"
}

# ------------------------------------------------------------ 6. Configuration (.env)
$firstInstall = -not $keepEnv
$adminPassword = $null
if ($firstInstall) {
  Step 'Generation de la configuration et des secrets'
  $adminPassword = New-Secret 15
  $dataDir = (Join-Path $InstallDir 'data\pglite').Replace('\', '/')
  $keepEnv = @"
# EzGed ControlCenter - genere par install-console.ps1 le $(Get-Date -Format s)
NODE_ENV=production
LOG_LEVEL=warn
HOST=127.0.0.1
PORT=$Port
BASE_PATH=$BasePath
PUBLIC_URL=$publicUrl
TRUST_PROXY=1
PGLITE_DIR=$dataDir

ADMIN_USER=admin
ADMIN_PASSWORD=$adminPassword
SESSION_SECRET=$(New-Secret 48)
ENROLL_KEY=$(New-Secret 32)
# Double authentification : voir la fin de l'installation.
ADMIN_TOTP_SECRET=

OFFLINE_MINUTES=5
RETENTION_DAYS=30

# Notifications (optionnelles)
ALERT_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
ALERT_EMAIL_TO=
"@
} else {
  Step 'Configuration existante conservee'
}
# UTF-8 sans BOM : un BOM fausserait le nom de la premiere variable.
[IO.File]::WriteAllText($EnvFile, $keepEnv, (New-Object Text.UTF8Encoding($false)))

# ------------------------------------------------------------ 7. Tache planifiee
Step "Tache planifiee '$TaskName'"
$runner = Join-Path $InstallDir 'run-console.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Step 'Demarrage de la console'
$local = "http://127.0.0.1:$Port$BasePath/api/auth-info"
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  Start-Sleep -Seconds 2
  try { $ok = (Invoke-WebRequest -Uri $local -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
}
if (-not $ok) { throw "La console ne repond pas sur $local. Journal : $(Join-Path $InstallDir 'logs\console.log')" }
Write-Host "Console OK en local ($local)"

# ------------------------------------------------------------ 8. Tailscale Funnel
if (-not $SkipFunnel) {
  Step "Publication Tailscale Funnel sur $BasePath"
  & $ts funnel --bg --set-path=$BasePath "http://127.0.0.1:$Port"
  if ($LASTEXITCODE -ne 0) { throw 'tailscale funnel a echoue.' }
  & $ts funnel status
  $remoteOk = $false
  for ($i = 0; $i -lt 10 -and -not $remoteOk; $i++) {
    try { $remoteOk = (Invoke-WebRequest -Uri "$publicUrl/api/auth-info" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200 } catch { Start-Sleep -Seconds 3 }
  }
  if ($remoteOk) { Write-Host "Console joignable : $publicUrl" -ForegroundColor Green }
  else { Write-Warning "Pas encore de reponse sur $publicUrl (le certificat peut prendre une minute). Reessayez dans un navigateur." }
}

# ------------------------------------------------------------ 9. Recapitulatif
Write-Host ''
Write-Host "Adresse de la console : $publicUrl/" -ForegroundColor Green
if ($adminPassword) {
  Write-Host "Utilisateur : admin"
  Write-Host "Mot de passe : $adminPassword" -ForegroundColor Yellow
  Write-Host "Notez-le maintenant : il n'est affiche qu'une fois (il reste dans $EnvFile, lisible par les administrateurs)."
  Write-Host ''
  Write-Host 'Double authentification conseillee :'
  Write-Host "  cd `"$ServerDir`"; & `"$nodeExe`" dist\tools\totp-new.js"
  Write-Host "  puis coller la ligne ADMIN_TOTP_SECRET=... dans $EnvFile et relancer ce script (configuration conservee)."
}
Write-Host "Journal : $(Join-Path $InstallDir 'logs\console.log')"
Write-Host "Scripts agent pour les serveurs EzGED : $(Join-Path $InstallDir 'agent')"
