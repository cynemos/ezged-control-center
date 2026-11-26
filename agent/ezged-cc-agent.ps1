#Requires -Version 3.0
<#
  EzGed ControlCenter - agent de supervision pour serveur EzGED.
  Lance par une tache planifiee (compte SYSTEM) toutes les minutes.
  Collecte l'etat du serveur et l'envoie en HTTPS a la console EzGed ControlCenter.
  Ne lit JAMAIS les secrets d'EzGED : seules quelques cles de instance.conf sont extraites.

  Usage manuel :
    powershell -ExecutionPolicy Bypass -File ezged-cc-agent.ps1 -DryRun -ForceInventory
#>
param(
  [string]$ConfigPath = (Join-Path $env:ProgramData 'EzGedControlCenter\config.json'),
  [switch]$ForceInventory,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '0.4.1'
$BaseDir = Split-Path -Parent $ConfigPath
$LogFile = Join-Path $BaseDir 'agent.log'
$StateFile = Join-Path $BaseDir 'state.json'

function Write-Log([string]$Message) {
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) {
      Move-Item $LogFile "$LogFile.1" -Force
    }
    Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date -Format 's'), $Message) -Encoding UTF8
  } catch { }
  if ($DryRun) { Write-Host $Message }
}

# Execute un bloc et renvoie $Default en cas d'erreur, sans interrompre la collecte.
# Les echecs sont aussi remontes a la console (sante de l'agent) pour reperer un indicateur
# qui ne fonctionne pas sur une version de Windows.
$script:CollectErrors = New-Object System.Collections.ArrayList
function Invoke-Safe([string]$Name, [scriptblock]$Block, $Default = $null) {
  try { & $Block } catch {
    $msg = $_.Exception.Message
    Write-Log "WARN [$Name] $msg"
    if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
    [void]$script:CollectErrors.Add([ordered]@{ name = $Name; error = $msg })
    $Default
  }
}
$script:Clock = [Diagnostics.Stopwatch]::StartNew()

function ConvertTo-IsoDate($Date) {
  if ($null -eq $Date) { return $null }
  return ([datetime]$Date).ToUniversalTime().ToString('o')
}

Add-Type -AssemblyName System.Security
function Unprotect-Secret([string]$Value) {
  if (-not $Value) { return $null }
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
    [Convert]::FromBase64String($Value), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  return [Text.Encoding]::UTF8.GetString($bytes)
}

# ---------------------------------------------------------------- configuration
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
# Disques locaux, pour chercher l'installation et les dumps hors de C: (ex. D:\nchp, D:\dumps).
$FixedDrives = @(Invoke-Safe 'drives' { Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID } } @('C:'))
$Root = $cfg.nchpRoot
if (-not $Root) {
  $Root = $FixedDrives | ForEach-Object { "$_\nchp" } |
    Where-Object { Test-Path (Join-Path $_ 'etc\nchp\ezged\instance.conf') } | Select-Object -First 1
  if (-not $Root) { $Root = 'C:\nchp' }
}
$Services = if ($cfg.services) { @($cfg.services) } else { @('Apache2.4', 'EzGED', 'MySQL') }
# URL publique EzGED via Apache (optionnelle) : doit repondre 2xx/3xx/401/403.
$WebUrl = $cfg.httpUrl
# Dossiers de dumps : backupDir impose par la configuration, sinon recherche (voir Get-BackupState).
$BackupDirs = if ($cfg.backupDir) { @($cfg.backupDir) } else {
  @(Join-Path $Root 'save_dump'; Join-Path $Root 'save_dumps') + @($FixedDrives | ForEach-Object {
      # Chemin de destination du job EzGED "Sauvegarde de BDD" : souvent C:\save_dumps ou D:\dumps.
      "$_\nchp\save_dump"; "$_\nchp\save_dumps"; "$_\nchpdata\save_dump"; "$_\nchpdata\save_dumps"; "$_\nchpdata\dumps"
      "$_\save_dump"; "$_\save_dumps"; "$_\dumps"
    }) | Select-Object -Unique
}
# Files de traitement : spoolDir impose, sinon [dirs] spooldir de instance.conf, sinon chemin standard.
$SpoolDir = $cfg.spoolDir
$Queues = if ($cfg.queues) { @($cfg.queues) } else { @('enqueued', 'wait', 'ocr', 'convd', 'pdf2txt', 'ps2pdf') }
$ApacheRoot = Join-Path $Root 'Apache24'
$EzgedConf = Join-Path $Root 'etc\nchp\ezged\instance.conf'

$state = @{ lastInventory = $null; inventoryIntervalMin = 60; cache = @{}; cpuTimes = @{} }
if (Test-Path $StateFile) {
  $s = Invoke-Safe 'state' { Get-Content $StateFile -Raw | ConvertFrom-Json }
  if ($s) {
    $state.lastInventory = $s.lastInventory
    $state.inventoryAgent = $s.inventoryAgent
    if ($s.inventoryIntervalMin) { $state.inventoryIntervalMin = $s.inventoryIntervalMin }
    if ($s.docs) { $state.docs = $s.docs }
    if ($s.cache) { foreach ($p in $s.cache.PSObject.Properties) { $state.cache[$p.Name] = $p.Value } }
    if ($s.cpuTimes) { foreach ($p in $s.cpuTimes.PSObject.Properties) { $state.cpuTimes[$p.Name] = $p.Value } }
  }
}

# Collectes moins urgentes : resultat garde dans state.json et renvoye tel quel entre deux calculs,
# pour alleger les vieux serveurs sans faire clignoter les alertes cote console.
function Get-Cached([string]$Name, [int]$Minutes, [scriptblock]$Block) {
  $c = $state.cache[$Name]
  if (-not $ForceInventory -and $c -and $c.at -and (((Get-Date) - [datetime]$c.at).TotalMinutes -lt $Minutes)) { return $c.value }
  $v = Invoke-Safe $Name $Block
  $state.cache[$Name] = @{ at = (Get-Date).ToString('o'); value = $v }
  return $v
}

# Age en heures recalcule a chaque envoi, la valeur en cache pouvant dater de plusieurs minutes.
function Get-AgeHours($IsoDate) {
  if (-not $IsoDate) { return $null }
  return [math]::Round(((Get-Date) - [datetime]$IsoDate).TotalHours, 1)
}

# ---------------------------------------------------------------- collecte rapide (chaque minute)
function Get-Metrics {
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
      $size = [double]$_.Size
      $free = [double]$_.FreeSpace
      [ordered]@{
        name    = $_.DeviceID
        sizeGB  = [math]::Round($size / 1GB, 1)
        freeGB  = [math]::Round($free / 1GB, 1)
        usedPct = if ($size -gt 0) { [math]::Round(100 * ($size - $free) / $size, 1) } else { 0 }
      }
    })
  $total = [double]$os.TotalVisibleMemorySize
  $freeMem = [double]$os.FreePhysicalMemory
  return [ordered]@{
    cpu         = [math]::Round([double]$cpu, 1)
    memUsedPct  = [math]::Round(100 * ($total - $freeMem) / $total, 1)
    memTotalMB  = [math]::Round($total / 1024)
    uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    disks       = $disks
  }
}

# Win32_Service plutot que Get-Service : StartType n'existe pas avec .NET < 4.6.1 (2008 R2),
# et on obtient le PID pour mesurer le processus.
$script:ServiceRows = @{}
function Get-ServiceStates {
  return @($Services | ForEach-Object {
      $name = $_
      $svc = Get-CimInstance Win32_Service -Filter "Name='$($name.Replace("'", "''"))'" -ErrorAction SilentlyContinue
      if ($svc) {
        $script:ServiceRows[$name] = $svc
        [ordered]@{ name = $name; status = ($svc.State -replace ' ', ''); startType = $svc.StartMode }
      } else { [ordered]@{ name = $name; status = 'NotFound' } }
    })
}

# Processus des services surveilles (httpd, mysqld, ezged...) : memoire, CPU, handles, depuis quand.
# Tous les processus du meme executable sont additionnes (Apache = parent + enfant qui travaille).
# CPU = temps processeur consomme depuis le rapport precedent / duree ecoulee / nombre de coeurs.
function Get-ProcessStates {
  $now = Get-Date
  $cores = [Environment]::ProcessorCount
  $newTimes = @{}
  $out = @()
  foreach ($name in $Services) {
    $svc = $script:ServiceRows[$name]
    if (-not $svc -or -not $svc.ProcessId) { continue }
    $main = Get-Process -Id $svc.ProcessId -ErrorAction SilentlyContinue
    if (-not $main) { continue }
    $procs = @(Get-Process -Name $main.ProcessName -ErrorAction SilentlyContinue)
    $cpuSec = 0.0
    foreach ($p in $procs) { try { $cpuSec += $p.TotalProcessorTime.TotalSeconds } catch { } }
    $key = "$name|$($svc.ProcessId)"
    $newTimes[$key] = @{ at = $now.ToString('o'); cpu = $cpuSec }
    $cpuPct = $null
    $prev = $state.cpuTimes[$key]
    if ($prev) {
      $elapsed = ($now - [datetime]$prev.at).TotalSeconds
      if ($elapsed -gt 5 -and $cpuSec -ge [double]$prev.cpu) {
        $cpuPct = [math]::Round(100 * ($cpuSec - [double]$prev.cpu) / $elapsed / $cores, 1)
      }
    }
    $started = $null
    try { $started = ConvertTo-IsoDate $main.StartTime } catch { }
    if (-not $started) {
      # StartTime peut etre refuse sur un processus systeme : Win32_Process le donne toujours.
      try { $started = ConvertTo-IsoDate (Get-CimInstance Win32_Process -Filter "ProcessId=$($svc.ProcessId)").CreationDate } catch { }
    }
    $out += [ordered]@{
      service   = $name
      name      = $main.ProcessName
      count     = $procs.Count
      memMB     = [math]::Round((($procs | Measure-Object WorkingSet64 -Sum).Sum) / 1MB)
      cpuPct    = $cpuPct
      handles   = ($procs | Measure-Object HandleCount -Sum).Sum
      threads   = ($procs | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum
      startedAt = $started
    }
  }
  # Le PID fait partie de la cle : un redemarrage du service repart d'une mesure neuve.
  $state.cpuTimes = $newTimes
  return $out
}

# Strict : seuls 2xx/3xx/401/403 sont valides (page reellement servie).
# Sinon : toute reponse HTTP < 500 prouve que le processus ecoute (le serveur EzGED renvoie 404 sur /).
# -Local : test en boucle locale (127.0.0.1), sans suivre les redirections (souvent vers le nom public)
# et sans verifier le certificat, qui ne peut pas correspondre a 127.0.0.1.
function Test-Http([string]$Url, [switch]$Strict, [switch]$Local) {
  $code = $null; $err = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    if ($Url.StartsWith('https')) {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
    }
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Timeout = 10000
    $req.AllowAutoRedirect = -not $Local
    if ($Local) { $req.ServerCertificateValidationCallback = { $true } }
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
  } catch [Net.WebException] {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode; $_.Exception.Response.Close() }
    else { $err = $_.Exception.Message }
  }
  $sw.Stop()
  if ($Strict) { $ok = ($null -ne $code) -and (($code -lt 400) -or ($code -eq 401) -or ($code -eq 403)) }
  else { $ok = ($null -ne $code) -and ($code -lt 500) }
  return [ordered]@{
    url    = $Url
    status = $code
    ms     = [int]$sw.ElapsedMilliseconds
    ok     = $ok
    error  = $err
  }
}

# Dump le plus recent parmi les dossiers candidats (dump_*.zip d'EzGED ou export SQL).
function Get-DumpSize($Item) {
  if (-not $Item) { return $null }
  if ($Item.PSIsContainer) { return [long](Get-ChildItem -Path $Item.FullName -File -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum }
  return [long]$Item.Length
}

function Get-BackupState {
  $existing = @($BackupDirs | Where-Object { Test-Path $_ -PathType Container })
  # Fichier dump (zip, sql...) ou, job en singlefile = 0, dossier dump_* contenant un fichier par table.
  # Les deux plus recents : le precedent sert a detecter un dump anormalement petit (tronque, base vide).
  $recent = @($existing | ForEach-Object {
      Get-ChildItem -Path $_ -ErrorAction SilentlyContinue |
        Where-Object {
          ($_.PSIsContainer -and $_.Name -match '^dump') -or
          (-not $_.PSIsContainer -and ($_.Name -match '^dump.*\.(zip|7z|gz|sql)$' -or $_.Name -match '\.sql(\.(gz|zip|7z))?$'))
        }
    } | Sort-Object LastWriteTime -Descending | Select-Object -First 2)
  $last = if ($recent.Count) { $recent[0] } else { $null }
  $size = Get-DumpSize $last
  $prevSize = if ($recent.Count -gt 1) { Get-DumpSize $recent[1] } else { $null }
  if ($last -and $last.PSIsContainer) { $dir = $last.Parent.FullName }
  elseif ($last) { $dir = $last.DirectoryName } elseif ($existing.Count) { $dir = $existing -join ', ' }
  else { $dir = ($BackupDirs | Select-Object -First 2) -join ', ' }
  return [ordered]@{
    dir       = $dir
    lastFile  = if ($last) { $last.Name } else { $null }
    lastAt    = if ($last) { ConvertTo-IsoDate $last.LastWriteTime } else { $null }
    sizeBytes = $size
    prevSizeBytes = $prevSize
    ageHours  = if ($last) { [math]::Round(((Get-Date) - $last.LastWriteTime).TotalHours, 1) } else { $null }
  }
}

# Veeam Agent for Windows (optionnel) : service, version et resultat des taches lus dans le
# journal 'Veeam Agent' (110 = tache demarree, 190 = tache terminee avec Success/Warning/Failed).
# Renvoie $null si Veeam n'est pas installe.
# Identifiant TeamViewer, lu dans le registre (installation 32 ou 64 bits, ou sous-cle VersionN des
# anciennes versions). Sert au bouton de prise en main de la console.
function Get-TeamViewerId {
  foreach ($root in 'HKLM:\SOFTWARE\WOW6432Node\TeamViewer', 'HKLM:\SOFTWARE\TeamViewer') {
    if (-not (Test-Path $root)) { continue }
    $keys = @(Get-Item $root) + @(Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^Version\d+$' })
    foreach ($k in $keys) {
      $id = (Get-ItemProperty -Path $k.PSPath -Name ClientID -ErrorAction SilentlyContinue).ClientID
      if ($id) { return [string]$id }
    }
  }
  return $null
}

function Get-VeeamState {
  $svc = Get-Service -Name 'VeeamEndpointBackupSvc' -ErrorAction SilentlyContinue
  if (-not $svc) { return $null }
  $version = $null
  try {
    $path = (Get-CimInstance Win32_Service -Filter "Name='VeeamEndpointBackupSvc'").PathName
    if ($path -match '^"([^"]+)"' -or $path -match '^(\S+)') { $version = (Get-Item $Matches[1]).VersionInfo.ProductVersion }
  } catch { }
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Veeam Agent'; Id = 110, 190 } -MaxEvents 200 -ErrorAction SilentlyContinue)
  $last = $null; $lastOk = $null; $job = $null; $result = $null; $details = $null
  foreach ($e in $events) {
    if ($e.Id -ne 190) { continue }
    $msg = [string]$e.Message
    $r = if ($msg -match 'finished with (\w+)') { $Matches[1] }
         elseif ($e.Level -eq 2) { 'Failed' } elseif ($e.Level -eq 3) { 'Warning' } else { 'Success' }
    if (-not $last) {
      $last = $e; $result = $r
      if ($msg -match "Veeam Agent '([^']+)'") { $job = $Matches[1] }
      if ($msg -match 'Job details:\s*(.+)') { $details = $Matches[1].Trim() }
      if ($details -and $details.Length -gt 300) { $details = $details.Substring(0, 300) }
    }
    # Warning : point de restauration cree malgre un avertissement, compte comme sauvegarde valide.
    if ($r -eq 'Success' -or $r -eq 'Warning') { $lastOk = $e; break }
  }
  # Tache en cours si le dernier evenement est un demarrage.
  $running = ($events.Count -gt 0) -and ($events[0].Id -eq 110)
  return [ordered]@{
    service    = $svc.Status.ToString()
    version    = $version
    job        = $job
    lastResult = $result
    lastAt     = if ($last) { ConvertTo-IsoDate $last.TimeCreated } else { $null }
    details    = $details
    lastOkAt   = if ($lastOk) { ConvertTo-IsoDate $lastOk.TimeCreated } else { $null }
    okAgeHours = if ($lastOk) { [math]::Round(((Get-Date) - $lastOk.TimeCreated).TotalHours, 1) } else { $null }
    running    = $running
    runningSince = if ($running) { ConvertTo-IsoDate $events[0].TimeCreated } else { $null }
  }
}

# Journal Systeme des dernieres 24 h : signes avant-coureurs de panne materielle ou d'instabilite.
#   EventLog 6008 = arret inattendu ; WER-SystemErrorReporting 1001 = ecran bleu (BugCheck) ;
#   disk 7/51/153/157 = secteur defectueux, erreur de pagination, nouvelle tentative d'E/S, disque retire ;
#   Ntfs 55/98/137 = corruption du systeme de fichiers.
function Get-EventHealth {
  $since = (Get-Date).AddHours(-24)
  # Niveaux 1-3 seulement (critique, erreur, avertissement) : Ntfs 98 existe aussi en information ("volume sain").
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 6008, 1001, 7, 51, 153, 157, 55, 98, 137; Level = 1, 2, 3; StartTime = $since } -MaxEvents 500 -ErrorAction SilentlyContinue)
  $kinds = @{ shutdown = 0; bugcheck = 0; disk = 0; ntfs = 0 }
  $last = @()
  foreach ($e in $events) {
    $p = [string]$e.ProviderName
    $kind = $null
    if ($e.Id -eq 6008 -and $p -eq 'EventLog') { $kind = 'shutdown' }
    elseif ($e.Id -eq 1001 -and $p -match 'WER-SystemErrorReporting|BugCheck') { $kind = 'bugcheck' }
    elseif ($p -eq 'disk' -and $e.Id -in 7, 51, 153, 157) { $kind = 'disk' }
    elseif ($p -match 'Ntfs' -and $e.Id -in 55, 98, 137) { $kind = 'ntfs' }
    if (-not $kind) { continue }
    $kinds[$kind]++
    if ($last.Count -lt 5) {
      $msg = ([string]$e.Message -split "`r?`n")[0]
      if ($msg.Length -gt 160) { $msg = $msg.Substring(0, 160) }
      $last += [ordered]@{ at = ConvertTo-IsoDate $e.TimeCreated; kind = $kind; source = $p; id = $e.Id; message = $msg }
    }
  }
  return [ordered]@{
    hours     = 24
    shutdowns = $kinds.shutdown
    bugchecks = $kinds.bugcheck
    diskErrors = $kinds.disk
    ntfsErrors = $kinds.ntfs
    last      = $last
  }
}

# Sante des disques physiques : prediction de panne SMART (root\wmi) et, a partir de 2012,
# etat du sous-systeme de stockage (Get-PhysicalDisk). Derriere un controleur RAID ou dans une VM,
# SMART n'est souvent pas expose : le disque apparait alors sans prediction.
function Get-DiskHealth {
  $smart = @{}
  try {
    Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop |
      ForEach-Object { $smart[($_.InstanceName -replace '_\d+$', '').ToUpper()] = [bool]$_.PredictFailure }
  } catch { }
  $phys = @{}
  if (Get-Command Get-PhysicalDisk -ErrorAction SilentlyContinue) {
    try {
      Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
        $phys[[string]$_.DeviceId] = [ordered]@{ health = [string]$_.HealthStatus; operational = [string]($_.OperationalStatus -join ',') }
      }
    } catch { }
  }
  return @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
      $pnp = ([string]$_.PNPDeviceID).ToUpper()
      $predict = $null
      foreach ($k in $smart.Keys) { if ($k -like "*$pnp*" -or $pnp -like "*$k*") { $predict = $smart[$k] } }
      $p = $phys[[string]$_.Index]
      [ordered]@{
        model          = ([string]$_.Model).Trim()
        sizeGB         = [math]::Round([double]$_.Size / 1GB)
        status         = [string]$_.Status
        predictFailure = $predict
        health         = if ($p) { $p.health } else { $null }
        operational    = if ($p) { $p.operational } else { $null }
      }
    })
}

# Fin d'un fichier texte (les journaux peuvent depasser le gigaoctet) : derniers $Bytes octets.
function Read-FileTail([string]$Path, [int]$Bytes = 1MB) {
  $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $len = [int][Math]::Min([long]$Bytes, $fs.Length)
    [void]$fs.Seek(-$len, [IO.SeekOrigin]::End)
    $buf = New-Object byte[] $len
    $read = $fs.Read($buf, 0, $len)
    return ([Text.Encoding]::UTF8.GetString($buf, 0, $read) -split "`r?`n")
  } finally { $fs.Close() }
}

# Erreurs des dernieres 24 h dans le journal d'erreurs d'Apache et dans celui de MariaDB.
function Get-LogErrors {
  $since = (Get-Date).AddHours(-24)
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $result = [ordered]@{}

  # Apache : [Wed Nov 18 14:00:00.123456 2026] [module:error] ...
  $apacheLog = Join-Path $ApacheRoot 'logs\error.log'
  if (Test-Path $apacheLog) {
    $count = 0; $lastLine = $null; $lastAt = $null
    foreach ($line in (Read-FileTail $apacheLog)) {
      if ($line -notmatch '^\[(\w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)? (\d{4})\] \[[^\]]*:(error|crit|alert|emerg)\]') { continue }
      $at = [datetime]::MinValue
      if (-not [datetime]::TryParseExact("$($Matches[1]) $($Matches[2])", 'ddd MMM dd HH:mm:ss yyyy', $inv, 'AllowWhiteSpaces', [ref]$at)) { continue }
      if ($at -lt $since) { continue }
      $count++; $lastLine = $line; $lastAt = $at
    }
    if ($lastLine -and $lastLine.Length -gt 200) { $lastLine = $lastLine.Substring(0, 200) }
    $result.apache = [ordered]@{ file = $apacheLog; errors = $count; lastAt = ConvertTo-IsoDate $lastAt; last = $lastLine }
  }

  # MariaDB : 2026-11-18 14:00:00 0 [ERROR] ...  (fichier <hote>.err du dossier data)
  $err = Get-ChildItem -Path (Join-Path $Root 'mysql\data') -Filter '*.err' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($err) {
    $count = 0; $lastLine = $null; $lastAt = $null
    foreach ($line in (Read-FileTail $err.FullName)) {
      if ($line -notmatch '^(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2}).*\[ERROR\]') { continue }
      $at = [datetime]::MinValue
      if (-not [datetime]::TryParse($Matches[1], $inv, 'AllowWhiteSpaces', [ref]$at)) { continue }
      if ($at -lt $since) { continue }
      $count++; $lastLine = $line; $lastAt = $at
    }
    if ($lastLine -and $lastLine.Length -gt 200) { $lastLine = $lastLine.Substring(0, 200) }
    $result.mariadb = [ordered]@{ file = $err.FullName; errors = $count; lastAt = ConvertTo-IsoDate $lastAt; last = $lastLine }
  }
  return $result
}

function Get-QueueStates {
  $result = [ordered]@{}
  if (-not $SpoolDir) {
    $script:SpoolDir = (Read-IniKeys $EzgedConf @{ 'dirs.spooldir' = 'spool' }).spool
    if (-not $SpoolDir -or -not (Test-Path $SpoolDir)) { $script:SpoolDir = Join-Path $Root 'var\spool\ezged\instance' }
  }
  foreach ($q in $Queues) {
    $dir = Join-Path $SpoolDir $q
    if (-not (Test-Path $dir)) { continue }
    $files = @(Get-ChildItem -Path $dir -File -Recurse -ErrorAction SilentlyContinue)
    $oldest = $null
    if ($files.Count -gt 0) {
      $min = ($files | Measure-Object -Property LastWriteTime -Minimum).Minimum
      $oldest = [math]::Round(((Get-Date) - $min).TotalMinutes, 1)
    }
    $result[$q] = [ordered]@{ count = $files.Count; oldestMin = $oldest }
  }
  return $result
}

function Get-DbState {
  if (-not $cfg.dbUser) { return $null }
  $mysql = Join-Path $Root 'mysql\bin\mysql.exe'
  $hostName = if ($cfg.dbHost) { $cfg.dbHost } else { '127.0.0.1' }
  $port = if ($cfg.dbPort) { [string]$cfg.dbPort } else { '3306' }
  $query = "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Max_used_connections','Slow_queries','Uptime')"
  # Mot de passe passe par variable d'environnement : invisible dans la liste des processus.
  $env:MYSQL_PWD = Unprotect-Secret $cfg.dbPasswordProtected
  try {
    $out = & $mysql -h $hostName -P $port -u $cfg.dbUser -N -B -e $query 2>&1
    $code = $LASTEXITCODE
  } finally {
    Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) {
    return [ordered]@{ ok = $false; error = (($out | Select-Object -First 1) -as [string]) }
  }
  $vals = @{}
  foreach ($line in $out) {
    $parts = ([string]$line) -split "`t"
    if ($parts.Count -ge 2) { $vals[$parts[0]] = [double]$parts[1] }
  }
  return [ordered]@{
    ok                 = $true
    threadsConnected   = $vals['Threads_connected']
    maxUsedConnections = $vals['Max_used_connections']
    slowQueries        = $vals['Slow_queries']
    uptimeHours        = if ($vals['Uptime']) { [math]::Round($vals['Uptime'] / 3600, 1) } else { $null }
  }
}

function Test-PendingReboot {
  if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { return $true }
  if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { return $true }
  $pfr = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
  return [bool]$pfr
}

# ---------------------------------------------------------------- inventaire (toutes les heures)
function Get-ExeVersion([string]$Exe, [string[]]$ExeArgs, [string]$Pattern) {
  if (-not (Test-Path $Exe)) { return $null }
  $out = (& $Exe @ExeArgs 2>&1 | Out-String)
  if ($out -match $Pattern) { return $Matches[1] }
  return $null
}

# Taille du stockage des documents ([dirs] stockagesdir, ex. C:\nchp\var\nchp\instance).
# Parcours couteux (millions de fichiers possibles) : au plus une fois par 24 h, limite a 90 s,
# resultat garde dans state.json entre deux calculs.
function Get-DocStorage {
  # docsDir impose par la configuration : stockage declare dans l'administration EzGED (hors instance.conf).
  $dir = $cfg.docsDir
  if (-not $dir) { $dir = (Read-IniKeys $EzgedConf @{ 'dirs.stockagesdir' = 'dir' }).dir }
  if (-not $dir) { $dir = Join-Path $Root 'var\nchp\instance' }
  $prev = $state.docs
  if (-not $ForceInventory -and $prev -and $prev.dir -eq $dir -and $prev.at -and
    ((Get-Date) - [datetime]$prev.at).TotalHours -lt 24) { return $prev }
  if (-not (Test-Path $dir -PathType Container)) { return [ordered]@{ dir = $dir; found = $false } }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $bytes = [long]0; $count = [long]0; $partial = $false
  foreach ($f in ([IO.DirectoryInfo]$dir).EnumerateFiles('*', [IO.SearchOption]::AllDirectories)) {
    $bytes += $f.Length; $count++
    if (($count % 2000) -eq 0 -and $sw.Elapsed.TotalSeconds -gt 90) { $partial = $true; break }
  }
  $result = [ordered]@{
    dir     = $dir
    found   = $true
    sizeGB  = [math]::Round($bytes / 1GB, 2)
    files   = $count
    partial = $partial
    seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    at      = (Get-Date).ToString('o')
  }
  $state.docs = $result
  return $result
}

# Lit uniquement les cles demandees d'un fichier INI (jamais les mots de passe).
function Read-IniKeys([string]$Path, [hashtable]$Wanted) {
  $result = @{}
  if (-not (Test-Path $Path)) { return $result }
  $section = ''
  foreach ($line in Get-Content $Path) {
    if ($line -match '^\s*\[(.+)\]\s*$') { $section = $Matches[1]; continue }
    if ($line -match '^\s*([^=#;]+?)\s*=\s*(.*)$') {
      $key = "$section.$($Matches[1])"
      if ($Wanted.ContainsKey($key)) { $result[$Wanted[$key]] = $Matches[2].Trim() }
    }
  }
  return $result
}

function Resolve-ApachePath([string]$p) {
  $p = $p.Trim().Trim('"').Replace('${SRVROOT}', $ApacheRoot).Replace('/', '\')
  if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $ApacheRoot $p }
}

# httpd.conf + fichiers inclus (un niveau), lignes commentees ignorees.
function Get-ApacheConfFiles {
  $httpd = Join-Path $ApacheRoot 'conf\httpd.conf'
  if (-not (Test-Path $httpd)) { return @() }
  $files = @($httpd)
  foreach ($line in Get-Content $httpd) {
    if ($line -match '^\s*Include(?:Optional)?\s+(.+)$') {
      $files += @(Get-ChildItem -Path (Resolve-ApachePath $Matches[1]) -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
    }
  }
  return $files
}

# Ports Apache (directives Listen) et protocole : https si "Listen 443 https" ou si un
# <VirtualHost *:port> active SSLEngine. Ports habituels sur EzGED : 80 ou 8000, 443 ou 4430.
function Get-ApacheListen {
  $ports = [ordered]@{}
  $ssl = @{}
  foreach ($f in @(Get-ApacheConfFiles)) {
    $vhostPorts = @()
    foreach ($line in Get-Content $f) {
      if ($line -match '^\s*Listen\s+(?:\S+:)?(\d+)(?:\s+(\w+))?') {
        $ports[$Matches[1]] = $true
        if ($Matches[2] -eq 'https') { $ssl[$Matches[1]] = $true }
      } elseif ($line -match '^\s*<VirtualHost\s+([^>]+)>') {
        $vhostPorts = @([regex]::Matches($Matches[1], ':(\d+)') | ForEach-Object { $_.Groups[1].Value })
      } elseif ($line -match '^\s*</VirtualHost>') {
        $vhostPorts = @()
      } elseif ($line -match '^\s*SSLEngine\s+on') {
        foreach ($vp in $vhostPorts) { $ssl[$vp] = $true }
      }
    }
  }
  return @($ports.Keys | ForEach-Object { [ordered]@{ port = [int]$_; https = [bool]$ssl[$_] } })
}

function Get-ApacheCertificates {
  $files = @(Get-ApacheConfFiles)
  if (-not $files.Count) { return @() }
  $resolve = { param($p) Resolve-ApachePath $p }
  $certs = @()
  $seen = @{}
  foreach ($f in $files) {
    foreach ($line in Get-Content $f) {
      if ($line -match '^\s*SSLCertificateFile\s+(.+)$') {
        $path = & $resolve $Matches[1]
        if ($seen.ContainsKey($path) -or -not (Test-Path $path)) { continue }
        $seen[$path] = $true
        $cert = Invoke-Safe "cert $path" { New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $path }
        if ($cert) {
          $certs += [ordered]@{
            file     = $path
            subject  = $cert.Subject
            notAfter = ConvertTo-IsoDate $cert.NotAfter
            daysLeft = [int][math]::Floor(($cert.NotAfter - (Get-Date)).TotalDays)
            thumbprint = $cert.Thumbprint
          }
        }
      }
    }
  }
  return $certs
}

# Sites Apache : un par <VirtualHost> (et un pour la configuration hors bloc s'il y a un ServerName),
# avec port, SSL, ServerName, ServerAlias et adresses de redirection (Redirect, RedirectMatch,
# RewriteRule vers une URL http(s)). Sert a afficher l'adresse publique de chaque serveur.
function Get-ApacheSites {
  $sites = @()
  $mainName = $null
  foreach ($f in @(Get-ApacheConfFiles)) {
    $cur = $null
    foreach ($line in Get-Content $f) {
      if ($line -match '^\s*<VirtualHost\s+([^>]+)>') {
        $port = [regex]::Match($Matches[1], ':(\d+)')
        $cur = [ordered]@{ port = if ($port.Success) { [int]$port.Groups[1].Value } else { $null }; ssl = $false; serverName = $null; aliases = @(); redirects = @() }
      } elseif ($line -match '^\s*</VirtualHost>') {
        if ($cur) { $sites += $cur }
        $cur = $null
      } elseif ($line -match '^\s*ServerName\s+(\S+)') {
        $name = $Matches[1].Trim('"')
        if ($cur) { $cur.serverName = $name } elseif (-not $mainName) { $mainName = $name }
      } elseif ($cur -and $line -match '^\s*ServerAlias\s+(.+)$') {
        $cur.aliases += @($Matches[1].Trim() -split '\s+' | Where-Object { $_ })
      } elseif ($cur -and $line -match '^\s*SSLEngine\s+on') {
        $cur.ssl = $true
      } elseif ($cur -and $line -match '^\s*(Redirect\w*|RewriteRule)\s.*?(https?://[^\s"]+)') {
        if ($cur.redirects -notcontains $Matches[2]) { $cur.redirects += $Matches[2] }
      }
    }
  }
  if ($mainName) { $sites += [ordered]@{ port = $null; ssl = $false; serverName = $mainName; aliases = @(); redirects = @(); main = $true } }
  return $sites
}

function Get-WindowsUpdateState {
  $pending = Invoke-Safe 'windows-update' {
    $searcher = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
    $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates.Count
  }
  $lastHotfix = Invoke-Safe 'hotfix' {
    Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1
  }
  return [ordered]@{
    pending         = $pending
    lastInstalledAt = if ($lastHotfix) { ConvertTo-IsoDate $lastHotfix.InstalledOn } else { $null }
  }
}

function Get-Inventory {
  $os = Get-CimInstance Win32_OperatingSystem
  $nt = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $build = "$($nt.CurrentBuildNumber)"
  if ($nt.UBR) { $build = "$build.$($nt.UBR)" }
  $cs = Get-CimInstance Win32_ComputerSystem
  $cpus = @(Get-CimInstance Win32_Processor)

  $ezConf = Read-IniKeys $EzgedConf @{ 'ezged.port' = 'port'; 'ezged.repository' = 'repository'; 'db.db_database' = 'database' }
  $revisionFile = Join-Path $Root 'etc\nchp\ezged\revision.txt'

  $dbSizeMB = $null
  if ($ezConf.database) {
    $dataDir = Join-Path $Root "mysql\data\$($ezConf.database)"
    if (Test-Path $dataDir) {
      $dbSizeMB = [math]::Round(((Get-ChildItem $dataDir -File -Recurse | Measure-Object Length -Sum).Sum) / 1MB)
    }
  }

  $docs = Invoke-Safe 'docs' { Get-DocStorage }

  return [ordered]@{
    os             = [ordered]@{
      caption     = $os.Caption
      version     = if ($nt.DisplayVersion) { $nt.DisplayVersion } else { $os.Version }
      build       = $build
      installDate = ConvertTo-IsoDate $os.InstallDate
    }
    versions       = [ordered]@{
      ezged   = Invoke-Safe 'ezged-version' { if (Test-Path $revisionFile) { (Get-Content $revisionFile -Raw).Trim() } }
      apache  = Invoke-Safe 'apache-version' { Get-ExeVersion (Join-Path $ApacheRoot 'bin\httpd.exe') @('-v') 'Apache/(\S+)' }
      php     = Invoke-Safe 'php-version' { Get-ExeVersion (Join-Path $ApacheRoot 'php\php.exe') @('-v') 'PHP (\S+)' }
      mariadb = Invoke-Safe 'mariadb-version' { Get-ExeVersion (Join-Path $Root 'mysql\bin\mysqld.exe') @('--version') 'Ver (\S+)' }
    }
    ezged          = [ordered]@{
      root       = $Root
      port       = $ezConf.port
      repository = $ezConf.repository
      database   = $ezConf.database
      dbSizeMB   = $dbSizeMB
      docs       = $docs
    }
    windowsUpdates = Get-WindowsUpdateState
    certificates   = @(Invoke-Safe 'certificates' { Get-ApacheCertificates } @())
    apacheSites    = @(Invoke-Safe 'apache-sites' { Get-ApacheSites } @())
    hardware       = [ordered]@{
      model   = $cs.Model
      cpuName = ($cpus | Select-Object -First 1).Name
      cores   = ($cpus | Measure-Object NumberOfCores -Sum).Sum
    }
  }
}

# ---------------------------------------------------------------- envoi
# Frequences : chaque minute pour ce qui peut tomber (services, ports, ressources, files),
# 5 a 15 min pour le reste (resultat en cache), inventaire toutes les heures.
$report = [ordered]@{
  agentVersion  = $AgentVersion
  hostname      = $env:COMPUTERNAME
  machineId     = Invoke-Safe 'machineId' { (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid }
  collectedAt   = ConvertTo-IsoDate (Get-Date)
  metrics       = Invoke-Safe 'metrics' { Get-Metrics }
  services      = @(Invoke-Safe 'services' { Get-ServiceStates } @())
  processes     = @(Invoke-Safe 'processes' { Get-ProcessStates } @())
  http          = Invoke-Safe 'http' {
    $port = (Read-IniKeys $EzgedConf @{ 'ezged.port' = 'port' }).port
    if (-not $port) { $port = '8080' }
    Test-Http "http://127.0.0.1:$port/"
  }
  # Acces web via Apache, teste en local sur chaque port Listen (liste relue toutes les 15 min).
  # Toute reponse < 500 prouve qu'Apache sert le port (la racine peut renvoyer 404 selon la configuration).
  apache        = @(Invoke-Safe 'apache' {
    @(Get-Cached 'apacheListen' 15 { Get-ApacheListen }) | Where-Object { $_ } | ForEach-Object {
      $scheme = if ($_.https) { 'https' } else { 'http' }
      Test-Http "${scheme}://127.0.0.1:$($_.port)/" -Local
    }
  } @())
  web           = if ($WebUrl) { Invoke-Safe 'web' { Test-Http $WebUrl -Strict } } else { $null }
  backup        = Get-Cached 'backup' 10 { Get-BackupState }
  veeam         = Get-Cached 'veeam' 5 { Get-VeeamState }
  teamviewerId  = Get-Cached 'teamviewer' 60 { Get-TeamViewerId }
  queues        = Invoke-Safe 'queues' { Get-QueueStates }
  db            = Invoke-Safe 'db' { Get-DbState }
  pendingReboot = Get-Cached 'reboot' 10 { Test-PendingReboot }
  events        = Get-Cached 'events' 15 { Get-EventHealth }
  disksHealth   = @(@(Get-Cached 'diskHealth' 60 { Get-DiskHealth }) | Where-Object { $_ })
  logs          = Get-Cached 'logs' 15 { Get-LogErrors }
}
if ($report.backup) { $report.backup.ageHours = Get-AgeHours $report.backup.lastAt }
if ($report.veeam) { $report.veeam.okAgeHours = Get-AgeHours $report.veeam.lastOkAt }
if ($null -eq $report.pendingReboot) { $report.pendingReboot = $false }

# Nouvelle version de l'agent : inventaire tout de suite, pour les informations qu'elle ajoute.
$inventoryDue = $ForceInventory -or -not $state.lastInventory -or ($state.inventoryAgent -ne $AgentVersion) -or
  (((Get-Date) - [datetime]$state.lastInventory).TotalMinutes -ge $state.inventoryIntervalMin)
if ($inventoryDue) {
  $report.inventory = Invoke-Safe 'inventory' { Get-Inventory }
}

# Sante de l'agent : duree de collecte, collectes en echec, environnement d'execution.
$report.agent = [ordered]@{
  durationMs = [int]$script:Clock.ElapsedMilliseconds
  # Rapport avec inventaire : bien plus long (recherche Windows Update), juge avec un autre seuil.
  inventory  = [bool]$report.inventory
  errors     = @($script:CollectErrors)
  ps         = $PSVersionTable.PSVersion.ToString()
  dotnet     = Invoke-Safe 'dotnet' { [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release).Release }
  autoUpdate = ($cfg.autoUpdate -ne $false)
}

$json = $report | ConvertTo-Json -Depth 8 -Compress

if ($DryRun) {
  $report | ConvertTo-Json -Depth 8
  return
}

# ---------------------------------------------------------------- remplacement du certificat SSL
# Demande depuis la console (page Certificat SSL) : l'agent recoit le certificat, la chaine et la cle,
# remplace les fichiers declares dans la configuration Apache, teste la configuration, redemarre
# Apache et verifie le certificat presente en HTTPS local. Au moindre echec : anciens fichiers remis.

# Trios (certificat, cle, chaine) de la configuration Apache : un par bloc (<VirtualHost> ou hors bloc).
function Get-ApacheSslSets {
  $sets = @()
  $seen = @{}
  foreach ($f in @(Get-ApacheConfFiles)) {
    $blk = @{}
    foreach ($line in (@(Get-Content $f) + @('</VirtualHost>'))) {
      if ($line -match '^\s*</?VirtualHost') {
        if ($blk.cert) {
          $k = "$($blk.cert)|$($blk.key)|$($blk.chain)"
          if (-not $seen[$k]) { $seen[$k] = $true; $sets += [pscustomobject]@{ cert = $blk.cert; key = $blk.key; chain = $blk.chain } }
        }
        $blk = @{}
      } elseif ($line -match '^\s*SSLCertificateFile\s+(.+)$') { $blk.cert = Resolve-ApachePath $Matches[1] }
      elseif ($line -match '^\s*SSLCertificateKeyFile\s+(.+)$') { $blk.key = Resolve-ApachePath $Matches[1] }
      elseif ($line -match '^\s*SSLCertificateChainFile\s+(.+)$') { $blk.chain = Resolve-ApachePath $Matches[1] }
    }
  }
  return $sets
}

function Get-CertCn($Cert) {
  return $Cert.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false).ToLower()
}

# Executable lance sans PowerShell : httpd ecrit sur stderr, ce qui leverait une erreur ici.
# Seul stderr est lu : httpd -t y ecrit tout son resultat.
function Invoke-Exe([string]$Exe, [string]$Arguments) {
  $psi = New-Object Diagnostics.ProcessStartInfo $Exe, $Arguments
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi)
  $err = $p.StandardError.ReadToEnd()
  if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch { }; throw "$Exe : delai depasse" }
  return [pscustomobject]@{ code = $p.ExitCode; output = $err.Trim() }
}

function Restart-Apache {
  $name = @($Services | Where-Object { $_ -like 'Apache*' })[0]
  if (-not $name) { $name = 'Apache2.4' }
  Restart-Service -Name $name -Force
  $svc = Get-Service -Name $name
  $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
  Start-Sleep -Seconds 3
  $svc.Refresh()
  if ($svc.Status -ne 'Running') { throw "service $name arrete juste apres son redemarrage" }
}

# Certificat presente par Apache en boucle locale (SNI = nom du certificat).
function Get-LocalTlsCert([int]$Port, [string]$HostName) {
  $tcp = New-Object Net.Sockets.TcpClient
  try {
    $iar = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { throw "port $Port injoignable" }
    $tcp.EndConnect($iar)
    $cb = [Net.Security.RemoteCertificateValidationCallback]{ $true }
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, $cb)
    $ssl.ReadTimeout = 10000
    $protocols = [Security.Authentication.SslProtocols]::Tls12 -bor [Security.Authentication.SslProtocols]::Tls11 -bor [Security.Authentication.SslProtocols]::Tls
    $ssl.AuthenticateAsClient($HostName, $null, $protocols, $false)
    $remote = $ssl.RemoteCertificate
    if (-not $remote) { throw "port $Port : aucun certificat recu" }
    # Copie des octets, lus avant la fermeture : le certificat de la connexion est alors libere.
    return New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (, $remote.GetRawCertData())
  } finally { $tcp.Close() }
}

# Chaque port HTTPS qui presente un certificat de ce nom doit presenter le nouveau.
function Test-ApacheCert([string]$Thumb, [string]$Cn) {
  $ports = @(Get-ApacheListen | Where-Object { $_.https } | ForEach-Object { $_.port })
  if (-not $ports.Count) { $ports = @(443) }
  $sni = if ($Cn.StartsWith('*.')) { 'ezged.' + $Cn.Substring(2) } else { $Cn }
  $matched = 0
  foreach ($port in $ports) {
    $seen = $null; $last = $null
    for ($i = 0; $i -lt 5 -and -not $seen; $i++) {
      try { $seen = Get-LocalTlsCert $port $sni } catch { $last = $_.Exception.Message; Start-Sleep -Seconds 2 }
    }
    if (-not $seen) { return "HTTPS local injoignable sur le port $port ($last)" }
    if ((Get-CertCn $seen) -ne $Cn) { continue }
    if ($seen.Thumbprint -ne $Thumb) { return "le port $port presente encore l'ancien certificat" }
    $matched++
  }
  if (-not $matched) { return "aucun port HTTPS ($($ports -join ', ')) ne presente le certificat $Cn" }
  return $null
}

function Install-SslBundle($P, [string]$Expected) {
  $X509 = 'Security.Cryptography.X509Certificates.X509Certificate2'
  $newCert = New-Object $X509 -ArgumentList (, [Text.Encoding]::ASCII.GetBytes([string]$P.cert))
  if ($newCert.Thumbprint -ne $Expected.ToUpper() -or $newCert.Thumbprint -ne ([string]$P.thumbprint).ToUpper()) {
    throw 'certificat recu different de celui annonce par la console'
  }
  if (-not ([string]$P.key).Contains('PRIVATE KEY') -or -not ([string]$P.chain).Contains('CERTIFICATE')) { throw 'fichiers recus incomplets' }
  $cn = ([string]$P.cn).ToLower()

  $sets = @(Get-ApacheSslSets | Where-Object { (Test-Path $_.cert) -and ((Get-CertCn (New-Object $X509 -ArgumentList $_.cert)) -eq $cn) })
  if (-not $sets.Count) { throw "aucun certificat $cn dans la configuration Apache" }
  foreach ($s in $sets) { if (-not $s.key) { throw "pas de SSLCertificateKeyFile associe a $($s.cert)" } }

  # Contenu de chaque fichier ; sans SSLCertificateChainFile, la chaine suit le certificat dans le meme fichier.
  $writes = [ordered]@{}
  foreach ($s in $sets) {
    if ($s.chain) { $writes[$s.cert] = [string]$P.cert; $writes[$s.chain] = [string]$P.chain }
    else { $writes[$s.cert] = [string]$P.cert + [string]$P.chain }
    $writes[$s.key] = [string]$P.key
  }

  # Sauvegarde a cote des originaux (memes droits d'acces que la cle actuelle).
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backups = [ordered]@{}
  foreach ($path in $writes.Keys) {
    if (Test-Path $path) { Copy-Item $path "$path.avant-$stamp" -Force; $backups[$path] = "$path.avant-$stamp" }
    else { $backups[$path] = $null }
  }

  $enc = New-Object Text.UTF8Encoding($false)
  $restarted = $false
  try {
    foreach ($path in $writes.Keys) {
      [IO.File]::WriteAllText($path, ($writes[$path] -replace "`r?`n", "`r`n"), $enc)
    }
    $syntax = Invoke-Exe (Join-Path $ApacheRoot 'bin\httpd.exe') '-t'
    if ($syntax.code -ne 0) { throw "configuration Apache refusee (httpd -t) : $($syntax.output)" }
    $restarted = $true
    Restart-Apache
    $check = Test-ApacheCert $newCert.Thumbprint $cn
    if ($check) { throw $check }
  } catch {
    $err = $_.Exception.Message
    foreach ($path in $backups.Keys) {
      if ($backups[$path]) { Copy-Item $backups[$path] $path -Force } else { Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }
    # Apache pas encore redemarre (echec avant) : il tourne toujours avec les anciens fichiers.
    $back = if (-not $restarted) { 'anciens fichiers remis, Apache pas redemarre' }
    else { try { Restart-Apache; 'anciens fichiers remis, Apache redemarre' } catch { "anciens fichiers remis, mais Apache ne redemarre pas : $($_.Exception.Message)" } }
    throw "$err ; $back"
  }
  return "certificat $cn remplace, expire le $($newCert.NotAfter.ToString('dd/MM/yyyy')) : $(@($writes.Keys) -join ', ') (sauvegardes *.avant-$stamp)"
}

function Invoke-SslDeploy($Offer, [string]$Token) {
  if (-not $Offer -or -not $Offer.id) { return }
  $url = $cfg.serverUrl.TrimEnd('/') + "/api/agent/ssl/$($Offer.id)"
  $headers = @{ Authorization = "Bearer $Token" }
  # Fichiers non remis (deja pris en charge, reseau...) : rien a signaler, la console reproposera.
  $payload = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 30 @Basic
  Write-Log "SSL : remplacement du certificat $($Offer.cn)"
  $ok = $false
  try { $msg = Install-SslBundle $payload ([string]$Offer.thumbprint); $ok = $true } catch { $msg = $_.Exception.Message }
  $payload = $null
  Write-Log ("SSL : " + $(if ($ok) { 'OK ' } else { 'ECHEC ' }) + $msg)
  $body = @{ ok = $ok; message = $msg } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$url/result" -Headers $headers -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 @Basic | Out-Null
  if ($ok) {
    # Inventaire au prochain passage : la console voit le nouveau certificat sans attendre une heure.
    $state.lastInventory = $null
    $state | ConvertTo-Json -Depth 10 | Set-Content -Path $StateFile -Encoding UTF8
  }
}

# Mise a jour de l'agent proposee par la console : uniquement vers une version superieure,
# script verifie par son empreinte SHA256 et par une analyse syntaxique avant de remplacer celui-ci.
function Update-Agent($Offer, [string]$Token) {
  if ($cfg.autoUpdate -eq $false -or -not $Offer -or -not $Offer.version -or -not $Offer.sha256) { return }
  if ([version]$Offer.version -le [version]$AgentVersion) { return }
  $url = $cfg.serverUrl.TrimEnd('/') + '/api/agent/script'
  $tmp = Join-Path $BaseDir 'ezged-cc-agent.new'
  Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $Token" } -OutFile $tmp -TimeoutSec 60 -UseBasicParsing
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($tmp)
  try { $hash = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Close() }
  if ($hash -ne ([string]$Offer.sha256).ToLower()) { Remove-Item $tmp -Force; throw "empreinte differente ($hash)" }
  $tokens = $null; $parseErrors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($tmp, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { Remove-Item $tmp -Force; throw "script invalide : $($parseErrors[0].Message)" }
  Move-Item $tmp $PSCommandPath -Force
  Write-Log "Agent mis a jour : $AgentVersion -> $($Offer.version)"
}

# -UseBasicParsing n'existe pas sur Invoke-RestMethod en PowerShell 3.0 (inutile pour du JSON).
$Basic = @{}
if ((Get-Command Invoke-RestMethod).Parameters.ContainsKey('UseBasicParsing')) { $Basic.UseBasicParsing = $true }

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $token = Unprotect-Secret $cfg.tokenProtected
  $resp = Invoke-RestMethod -Method Post -Uri ($cfg.serverUrl.TrimEnd('/') + '/api/agent/report') `
    -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 30 @Basic
  if ($inventoryDue -and $report.inventory) { $state.lastInventory = (Get-Date).ToString('o'); $state.inventoryAgent = $AgentVersion }
  if ($resp.inventoryIntervalMin) { $state.inventoryIntervalMin = [int]$resp.inventoryIntervalMin }
  $state | ConvertTo-Json -Depth 10 | Set-Content -Path $StateFile -Encoding UTF8
} catch {
  Write-Log "ERROR envoi : $($_.Exception.Message)"
  exit 1
}

# Apres l'envoi : un echec de mise a jour ne doit pas empecher le rapport.
Invoke-Safe 'ssl' { Invoke-SslDeploy $resp.sslDeploy $token } | Out-Null
Invoke-Safe 'update' { Update-Agent $resp.agentUpdate $token } | Out-Null
