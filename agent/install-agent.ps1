#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
  Installe l'agent EzGed ControlCenter sur un serveur EzGED.

  Exemple :
    powershell -ExecutionPolicy Bypass -File install-agent.ps1 -ServerUrl https://ezged-cc.mondomaine.fr -EnrollKey XXXX

  Optionnel :
    -NchpRoot C:\nchp           racine EzGED si differente
    -RustDeskId 123456789       identifiant RustDesk (detecte automatiquement si RustDesk est installe)
    -DbUser ezgedcc               compte MariaDB de supervision (le mot de passe est demande)
    -Reenroll                   force un nouvel enregistrement (nouveau serveur dans la console)
#>
param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [Parameter(Mandatory = $true)][string]$EnrollKey,
  [string]$NchpRoot = 'C:\nchp',
  [string]$RustDeskId,
  [string]$DbUser,
  [switch]$Reenroll
)

$ErrorActionPreference = 'Stop'
$TaskName = 'EzGed ControlCenter Agent'
$Dir = Join-Path $env:ProgramData 'EzGedControlCenter'
$ConfigPath = Join-Path $Dir 'config.json'
$AgentPath = Join-Path $Dir 'ezged-cc-agent.ps1'

Add-Type -AssemblyName System.Security
function Protect-Secret([string]$Value) {
  $bytes = [Security.Cryptography.ProtectedData]::Protect(
    [Text.Encoding]::UTF8.GetBytes($Value), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  return [Convert]::ToBase64String($bytes)
}

if (-not $ServerUrl.StartsWith('https://')) {
  Write-Warning "ServerUrl n'est pas en HTTPS : le jeton circulera en clair. A reserver aux tests."
}

# 1. Dossier reserve a SYSTEM et aux administrateurs
New-Item -ItemType Directory -Path $Dir -Force | Out-Null
& icacls $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'ezged-cc-agent.ps1') -Destination $AgentPath -Force

# 2. Identifiant RustDesk
if (-not $RustDeskId) {
  $rd = Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'
  if (Test-Path $rd) {
    $RustDeskId = ((& $rd --get-id | Out-String).Trim() -split "`r?`n")[-1].Trim()
    Write-Host "RustDesk detecte, ID : $RustDeskId"
  }
}

# 3. Enregistrement aupres de la console (une seule fois)
$existing = $null
if (Test-Path $ConfigPath) { $existing = Get-Content $ConfigPath -Raw | ConvertFrom-Json }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($existing -and $existing.tokenProtected -and -not $Reenroll) {
  Write-Host "Agent deja enregistre (serveur $($existing.serverId)) : jeton conserve."
  $serverId = $existing.serverId
  $tokenProtected = $existing.tokenProtected
} else {
  # MachineGuid : identifie la machine pour que la console reutilise sa fiche en cas de reinstallation
  $machineId = $null
  try { $machineId = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid } catch { }
  $body = @{ enrollKey = $EnrollKey; hostname = $env:COMPUTERNAME; rustdeskId = $RustDeskId; machineId = $machineId } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri ($ServerUrl.TrimEnd('/') + '/api/agent/enroll') `
    -ContentType 'application/json' -Body $body -TimeoutSec 30 -UseBasicParsing
  $serverId = $resp.serverId
  $tokenProtected = Protect-Secret $resp.token
  if ($resp.reused) { Write-Host "Serveur deja connu de la console, fiche conservee : $serverId" }
  else { Write-Host "Serveur enregistre : $serverId" }
}

# 4. Configuration (jeton et mot de passe chiffres DPAPI, lisibles uniquement sur cette machine)
$config = [ordered]@{
  serverUrl      = $ServerUrl.TrimEnd('/')
  serverId       = $serverId
  tokenProtected = $tokenProtected
  nchpRoot       = $NchpRoot
}
if ($DbUser) {
  $dbPwd = Read-Host "Mot de passe MariaDB pour $DbUser" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($dbPwd))
  $config.dbUser = $DbUser
  $config.dbPasswordProtected = Protect-Secret $plain
} elseif ($existing -and $existing.dbUser) {
  $config.dbUser = $existing.dbUser
  $config.dbPasswordProtected = $existing.dbPasswordProtected
}
$config | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8

# 5. Tache planifiee : toutes les minutes, compte SYSTEM
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentPath`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# 6. Premier envoi immediat avec inventaire complet
Start-ScheduledTask -TaskName $TaskName
Write-Host "Agent installe. Journal : $(Join-Path $Dir 'agent.log')"
