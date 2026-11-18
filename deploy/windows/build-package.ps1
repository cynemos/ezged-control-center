#Requires -Version 5.1
<#
  Construit le paquet d'installation Windows de la console EzGed ControlCenter.
  A lancer sur le poste de developpement, depuis n'importe quel dossier :
    powershell -ExecutionPolicy Bypass -File deploy\windows\build-package.ps1

  Resultat : dist-package\ezgedcc-console.zip, a copier sur le serveur puis a extraire.
  -Version v0.3.0 : numero inscrit dans VERSION.txt (utilise par update-console.ps1) ; GitHub Actions passe le tag.
#>
param([string]$Version)
$ErrorActionPreference = 'Stop'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Out = Join-Path $Repo 'dist-package'
$Stage = Join-Path $Out 'ezgedcc-console'
$Zip = Join-Path $Out 'ezgedcc-console.zip'

function Invoke-Npm([string]$Dir, [string[]]$NpmArgs) {
  Push-Location $Dir
  try {
    & npm.cmd @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') a echoue dans $Dir" }
  } finally { Pop-Location }
}

Write-Host 'Compilation de l''API...'
Invoke-Npm (Join-Path $Repo 'server') @('run', 'build')
Write-Host 'Compilation de l''interface...'
Invoke-Npm (Join-Path $Repo 'web') @('run', 'build')

if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'app\server'), (Join-Path $Stage 'app\web'), (Join-Path $Stage 'agent') | Out-Null

Copy-Item (Join-Path $Repo 'server\dist') (Join-Path $Stage 'app\server\dist') -Recurse
Copy-Item (Join-Path $Repo 'server\package.json'), (Join-Path $Repo 'server\package-lock.json') (Join-Path $Stage 'app\server')
Copy-Item (Join-Path $Repo 'web\dist') (Join-Path $Stage 'app\web\dist') -Recurse
Copy-Item (Join-Path $Repo 'agent\*.ps1') (Join-Path $Stage 'agent')
Copy-Item (Join-Path $PSScriptRoot 'install-console.ps1'), (Join-Path $PSScriptRoot 'run-console.ps1'), (Join-Path $PSScriptRoot 'update-console.ps1') $Stage

$commit = (& git -C $Repo rev-parse --short HEAD 2>$null)
if (-not $Version) { $Version = "dev-$commit" }
# Premiere colonne = version, lue par update-console.ps1 pour savoir si une mise a jour est necessaire.
Set-Content -Path (Join-Path $Stage 'VERSION.txt') -Value ("{0} {1} {2}" -f $Version, $commit, (Get-Date -Format s)) -Encoding ASCII

if (Test-Path $Zip) { Remove-Item $Zip -Force }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip
Write-Host "Paquet pret : $Zip"
