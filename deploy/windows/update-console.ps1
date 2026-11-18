#Requires -Version 5.1
<#
  Met a jour la console EzGed ControlCenter depuis la derniere release GitHub.
  A lancer en PowerShell administrateur sur le serveur de la console :
    powershell -ExecutionPolicy Bypass -File C:\EzGedControlCenter\update-console.ps1

  Le paquet (ezgedcc-console.zip) est construit par GitHub Actions a chaque tag v*,
  son empreinte SHA256 est verifiee, puis install-console.ps1 est lance : .env et donnees conserves.

  Options :
    -Tag v0.3.0      installe cette version plutot que la derniere (retour arriere possible)
    -Force           reinstalle meme si la version est deja en place
    -DownloadOnly    telecharge et verifie le paquet sans l'installer (dossier affiche)
    -Port, -BasePath, -SkipFunnel   transmis a install-console.ps1
#>
param(
  [string]$Tag,
  [switch]$Force,
  [switch]$DownloadOnly,
  [string]$InstallDir = 'C:\EzGedControlCenter',
  [string]$Repo = 'cynemos/ezged-control-center',
  [int]$Port = 8797,
  [string]$BasePath = '/ezgedcc',
  [switch]$SkipFunnel
)

$ErrorActionPreference = 'Stop'
$admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $DownloadOnly) { throw 'Lancer ce script dans un PowerShell administrateur.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'ezgedcc-updater'; Accept = 'application/vnd.github+json' }

# 1. Release a installer
$api = if ($Tag) { "https://api.github.com/repos/$Repo/releases/tags/$Tag" } else { "https://api.github.com/repos/$Repo/releases/latest" }
try { $rel = Invoke-RestMethod -Uri $api -Headers $headers -UseBasicParsing }
catch { throw "Release introuvable ($api) : $($_.Exception.Message)" }
$zipAsset = $rel.assets | Where-Object name -eq 'ezgedcc-console.zip' | Select-Object -First 1
$shaAsset = $rel.assets | Where-Object name -eq 'ezgedcc-console.zip.sha256' | Select-Object -First 1
if (-not $zipAsset -or -not $shaAsset) { throw "La release $($rel.tag_name) ne contient pas le paquet et son empreinte." }

# 2. Version en place (premiere ligne de VERSION.txt : "<tag> <commit> <date>")
$current = $null
$versionFile = Join-Path $InstallDir 'VERSION.txt'
if (Test-Path $versionFile) { $current = ((Get-Content $versionFile -TotalCount 1) -split '\s+')[0] }
Write-Host "Version installee : $(if ($current) { $current } else { 'inconnue' })"
Write-Host "Version publiee   : $($rel.tag_name) ($($rel.published_at))"
if ($current -eq $rel.tag_name -and -not $Force -and -not $DownloadOnly) {
  Write-Host 'Deja a jour. -Force pour reinstaller.' -ForegroundColor Green
  return
}

# 3. Telechargement et verification de l'empreinte
$work = Join-Path $env:TEMP "ezgedcc-update-$($rel.tag_name)"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null
$zip = Join-Path $work 'ezgedcc-console.zip'
Write-Host "Telechargement de $($zipAsset.browser_download_url)"
Invoke-WebRequest -Uri $zipAsset.browser_download_url -Headers @{ 'User-Agent' = 'ezgedcc-updater' } -OutFile $zip -UseBasicParsing
$expected = ((Invoke-WebRequest -Uri $shaAsset.browser_download_url -Headers @{ 'User-Agent' = 'ezgedcc-updater' } -UseBasicParsing).Content |
    ForEach-Object { if ($_ -is [byte[]]) { [Text.Encoding]::ASCII.GetString($_) } else { $_ } }).Trim().Split(' ')[0].ToLower()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "Empreinte SHA256 differente : attendue $expected, obtenue $actual. Installation annulee." }
Write-Host "Empreinte SHA256 verifiee : $actual"

$src = Join-Path $work 'pkg'
Expand-Archive -Path $zip -DestinationPath $src -Force
Get-ChildItem $src -Recurse -File | Unblock-File
if ($DownloadOnly) { Write-Host "Paquet verifie et extrait dans $src (non installe)."; return }

# 4. Installation (arret, copie, npm ci, redemarrage, controles)
$installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $src 'install-console.ps1'),
  '-InstallDir', $InstallDir, '-Port', $Port, '-BasePath', $BasePath)
if ($SkipFunnel) { $installArgs += '-SkipFunnel' }
& powershell.exe @installArgs
if ($LASTEXITCODE -ne 0) { throw "install-console.ps1 a echoue (code $LASTEXITCODE). Le dossier $src est conserve pour analyse." }

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Console mise a jour en $($rel.tag_name)." -ForegroundColor Green
