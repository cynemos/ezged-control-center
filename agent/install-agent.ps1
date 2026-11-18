<#
  Installe l'agent EzGed ControlCenter sur un serveur EzGED.
  Compatible Windows 10, Server 2008 R2 SP1, 2012/2012 R2, 2016, 2019, 2022, 2025
  (PowerShell 3.0 et .NET 4.5 minimum, voir les pre-controles ci-dessous).

  Exemple :
    powershell -ExecutionPolicy Bypass -File install-agent.ps1 -ServerUrl https://ezged-cc.mondomaine.fr -EnrollKey XXXX

  Optionnel :
    -NchpRoot D:\nchp           racine EzGED (sinon detectee : X:\nchp sur les disques locaux)
    -BackupDir E:\sauvegardes   dossier des dumps (sinon recherche : nchp\save_dump(s), nchpdata\..., X:\dumps)
    -RustDeskId 123456789       identifiant RustDesk (detecte automatiquement si RustDesk est installe)
    -DbUser ezgedcc             compte MariaDB de supervision (le mot de passe est demande)
    -Reenroll                   force un nouvel enregistrement (nouveau serveur dans la console)
    -NoAutoUpdate               refuse les mises a jour automatiques de l'agent proposees par la console
    -SkipTlsFix                 ne touche pas au registre TLS (voir etape 0)
#>
param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [Parameter(Mandatory = $true)][string]$EnrollKey,
  [string]$NchpRoot,
  [string]$BackupDir,
  [string]$RustDeskId,
  [string]$DbUser,
  [switch]$Reenroll,
  [switch]$NoAutoUpdate,
  [switch]$SkipTlsFix
)

# Pas de #Requires : sur un PowerShell trop ancien, on veut un message clair plutot qu'une erreur brute.
# Ce debut de script doit rester lisible par PowerShell 2.0 (Server 2008 R2 d'origine).
$ErrorActionPreference = 'Stop'

function Stop-Install([string]$Message) {
  Write-Host ''
  Write-Host "ECHEC : $Message" -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- 0. pre-controles
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Stop-Install 'lancer ce script dans un PowerShell "Executer en tant qu''administrateur".'
}

$os = Get-WmiObject Win32_OperatingSystem
Write-Host "Systeme    : $($os.Caption) (build $($os.BuildNumber))"
Write-Host "PowerShell : $($PSVersionTable.PSVersion)"

$net = 0
try { $net = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release).Release } catch { }
$netLabel = if ($net -ge 528040) { '4.8' } elseif ($net -ge 461808) { '4.7.2' } elseif ($net -ge 394802) { '4.6.2' } elseif ($net -ge 379893) { '4.5.2' } elseif ($net -gt 0) { '4.5 ou 4.5.1' } else { 'absent' }
Write-Host ".NET 4     : $netLabel"

# .NET 4.5 : TLS 1.2 et controle de certificat par requete (Server 2012 l'a d'origine).
if ($net -lt 378389) {
  Stop-Install ".NET Framework 4.5 minimum requis (4.8 conseille) : installer .NET 4.8 puis relancer."
}
# PowerShell 3.0 suffit : pas besoin de WMF 5.1 (ni du redemarrage qu'il impose) sur 2012 / 2008 R2 a jour.
if ($PSVersionTable.PSVersion.Major -lt 3) {
  $hint = if ([int]$os.BuildNumber -lt 7601) { 'Windows Server 2008 sans R2 SP1 n''est pas pris en charge.' }
          else { 'Installer .NET 4.8 puis Windows Management Framework 3.0 (KB2506143) ou 5.1 (KB3191566), redemarrer, puis relancer.' }
  Stop-Install "PowerShell 3.0 minimum requis (version actuelle : $($PSVersionTable.PSVersion)). $hint"
}

# TLS 1.2 : indispensable pour joindre la console (Tailscale Funnel, Caddy n'acceptent que TLS 1.2+).
# Sur 2008 R2 et 2012, .NET et SChannel ne l'activent pas par defaut : on l'active, sans rien desactiver.
function Set-RegDword([string]$Path, [string]$Name, [int]$Value) {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  $cur = (Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue).$Name
  if ($cur -ne $Value) { New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType DWord -Force | Out-Null; return $true }
  return $false
}
$tlsChanged = $false
if (-not $SkipTlsFix) {
  foreach ($p in 'HKLM:\SOFTWARE\Microsoft\.NETFramework\v4.0.30319', 'HKLM:\SOFTWARE\Wow6432Node\Microsoft\.NETFramework\v4.0.30319') {
    if (Set-RegDword $p 'SchUseStrongCrypto' 1) { $tlsChanged = $true }
    if (Set-RegDword $p 'SystemDefaultTlsVersions' 1) { $tlsChanged = $true }
  }
  if ([int]$os.BuildNumber -lt 9600) {
    # 2008 R2 / 2012 : TLS 1.2 client desactive par defaut dans SChannel.
    $sc = 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client'
    if (Set-RegDword $sc 'Enabled' 1) { $tlsChanged = $true }
    if (Set-RegDword $sc 'DisabledByDefault' 0) { $tlsChanged = $true }
  }
  if ($tlsChanged) { Write-Host 'TLS 1.2 active dans le registre (.NET / SChannel).' -ForegroundColor Yellow }
}

if (-not $ServerUrl.StartsWith('https://')) {
  Write-Warning "ServerUrl n'est pas en HTTPS : le jeton circulera en clair. A reserver aux tests."
}
$ServerUrl = $ServerUrl.TrimEnd('/')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Test de connexion avant toute modification de la machine.
try {
  Invoke-RestMethod -Uri "$ServerUrl/api/auth-info" -TimeoutSec 20 -UseBasicParsing | Out-Null
  Write-Host "Console    : joignable ($ServerUrl)"
} catch {
  $msg = $_.Exception.Message
  $hint = if ($tlsChanged -and [int]$os.BuildNumber -lt 9600) { ' Le registre TLS vient d''etre modifie : redemarrer le serveur puis relancer ce script.' }
          elseif ($msg -match 'SSL|TLS|canal|secure channel') { ' Probleme TLS : verifier que les mises a jour Windows sont installees (KB3140245 sur 2008 R2).' }
          else { ' Verifier l''adresse, le DNS et le pare-feu sortant (HTTPS 443).' }
  Stop-Install "console injoignable : $msg.$hint"
}

# ---------------------------------------------------------------- installation
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

if ($existing -and $existing.tokenProtected -and -not $Reenroll) {
  Write-Host "Agent deja enregistre (serveur $($existing.serverId)) : jeton conserve."
  $serverId = $existing.serverId
  $tokenProtected = $existing.tokenProtected
} else {
  # MachineGuid : identifie la machine pour que la console reutilise sa fiche en cas de reinstallation
  $machineId = $null
  try { $machineId = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid } catch { }
  $body = @{ enrollKey = $EnrollKey; hostname = $env:COMPUTERNAME; rustdeskId = $RustDeskId; machineId = $machineId } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri "$ServerUrl/api/agent/enroll" `
    -ContentType 'application/json' -Body $body -TimeoutSec 30 -UseBasicParsing
  $serverId = $resp.serverId
  $tokenProtected = Protect-Secret $resp.token
  if ($resp.reused) { Write-Host "Serveur deja connu de la console, fiche conservee : $serverId" }
  else { Write-Host "Serveur enregistre : $serverId" }
}

# 4. Configuration (jeton et mot de passe chiffres DPAPI, lisibles uniquement sur cette machine)
$config = [ordered]@{
  serverUrl      = $ServerUrl
  serverId       = $serverId
  tokenProtected = $tokenProtected
}
# Sans -NchpRoot, l'agent cherche lui-meme X:\nchp sur les disques locaux.
if ($NchpRoot) { $config.nchpRoot = $NchpRoot } elseif ($existing -and $existing.nchpRoot) { $config.nchpRoot = $existing.nchpRoot }
# Dossier des dumps s'il n'est pas dans un emplacement connu (save_dump(s), nchpdata, X:\dumps).
if ($BackupDir) { $config.backupDir = $BackupDir } elseif ($existing -and $existing.backupDir) { $config.backupDir = $existing.backupDir }
if ($DbUser) {
  $dbPwd = Read-Host "Mot de passe MariaDB pour $DbUser" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($dbPwd))
  $config.dbUser = $DbUser
  $config.dbPasswordProtected = Protect-Secret $plain
} elseif ($existing -and $existing.dbUser) {
  $config.dbUser = $existing.dbUser
  $config.dbPasswordProtected = $existing.dbPasswordProtected
}
if ($NoAutoUpdate) { $config.autoUpdate = $false }
$config | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8

# 5. Tache planifiee : toutes les minutes, compte SYSTEM.
# schtasks + XML plutot que Register-ScheduledTask, absent de Server 2008 R2.
$start = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Supervision EzGed ControlCenter : rapport chaque minute.</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT2M</Delay>
      <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$AgentPath"</Arguments>
    </Exec>
  </Actions>
</Task>
"@
$xmlPath = Join-Path $Dir 'task.xml'
[IO.File]::WriteAllText($xmlPath, $xml, [Text.Encoding]::Unicode)
$out = & schtasks.exe /Create /TN $TaskName /XML $xmlPath /F 2>&1
$code = $LASTEXITCODE
Remove-Item $xmlPath -Force
if ($code -ne 0) { Stop-Install "creation de la tache planifiee : $out" }

# 6. Premier envoi immediat avec inventaire complet, puis verification
$runAt = Get-Date
& schtasks.exe /Run /TN $TaskName | Out-Null
Write-Host 'Premier rapport en cours...'
$log = Join-Path $Dir 'agent.log'
$statePath = Join-Path $Dir 'state.json'
$ok = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  # state.json est reecrit apres chaque envoi accepte par la console.
  if ((Test-Path $statePath) -and (Get-Item $statePath).LastWriteTime -ge $runAt) { $ok = $true; break }
}
if ($ok) { Write-Host "Agent installe et premier rapport recu par la console." -ForegroundColor Green }
else {
  Write-Warning "Pas de rapport confirme apres 90 s. Journal : $log"
  if (Test-Path $log) { Get-Content $log -Tail 5 }
}
