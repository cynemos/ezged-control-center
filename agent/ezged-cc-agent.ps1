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
$AgentVersion = '0.2.2'
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
function Get-BackupState {
  $last = $null
  $existing = @($BackupDirs | Where-Object { Test-Path $_ -PathType Container })
  foreach ($d in $existing) {
    # Fichier dump (zip, sql...) ou, job en singlefile = 0, dossier dump_* contenant un fichier par table.
    $f = Get-ChildItem -Path $d -ErrorAction SilentlyContinue |
      Where-Object {
        ($_.PSIsContainer -and $_.Name -match '^dump') -or
        (-not $_.PSIsContainer -and ($_.Name -match '^dump.*\.(zip|7z|gz|sql)$' -or $_.Name -match '\.sql(\.(gz|zip|7z))?$'))
      } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f -and (-not $last -or $f.LastWriteTime -gt $last.LastWriteTime)) { $last = $f }
  }
  $size = $null
  if ($last -and $last.PSIsContainer) {
    $size = [long](Get-ChildItem -Path $last.FullName -File -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    $dir = $last.Parent.FullName
  } elseif ($last) {
    $size = $last.Length
    $dir = $last.DirectoryName
  } elseif ($existing.Count) { $dir = $existing -join ', ' }
  else { $dir = ($BackupDirs | Select-Object -First 2) -join ', ' }
  return [ordered]@{
    dir       = $dir
    lastFile  = if ($last) { $last.Name } else { $null }
    lastAt    = if ($last) { ConvertTo-IsoDate $last.LastWriteTime } else { $null }
    sizeBytes = $size
    ageHours  = if ($last) { [math]::Round(((Get-Date) - $last.LastWriteTime).TotalHours, 1) } else { $null }
  }
}

# Veeam Agent for Windows (optionnel) : service, version et resultat des taches lus dans le
# journal 'Veeam Agent' (110 = tache demarree, 190 = tache terminee avec Success/Warning/Failed).
# Renvoie $null si Veeam n'est pas installe.
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
  $dir = (Read-IniKeys $EzgedConf @{ 'dirs.stockagesdir' = 'dir' }).dir
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
          }
        }
      }
    }
  }
  return $certs
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
  queues        = Invoke-Safe 'queues' { Get-QueueStates }
  db            = Invoke-Safe 'db' { Get-DbState }
  pendingReboot = Get-Cached 'reboot' 10 { Test-PendingReboot }
}
if ($report.backup) { $report.backup.ageHours = Get-AgeHours $report.backup.lastAt }
if ($report.veeam) { $report.veeam.okAgeHours = Get-AgeHours $report.veeam.lastOkAt }
if ($null -eq $report.pendingReboot) { $report.pendingReboot = $false }

$inventoryDue = $ForceInventory -or -not $state.lastInventory -or
  (((Get-Date) - [datetime]$state.lastInventory).TotalMinutes -ge $state.inventoryIntervalMin)
if ($inventoryDue) {
  $report.inventory = Invoke-Safe 'inventory' { Get-Inventory }
}

# Sante de l'agent : duree de collecte, collectes en echec, environnement d'execution.
$report.agent = [ordered]@{
  durationMs = [int]$script:Clock.ElapsedMilliseconds
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
  if ($inventoryDue -and $report.inventory) { $state.lastInventory = (Get-Date).ToString('o') }
  if ($resp.inventoryIntervalMin) { $state.inventoryIntervalMin = [int]$resp.inventoryIntervalMin }
  $state | ConvertTo-Json -Depth 10 | Set-Content -Path $StateFile -Encoding UTF8
} catch {
  Write-Log "ERROR envoi : $($_.Exception.Message)"
  exit 1
}

# Apres l'envoi : un echec de mise a jour ne doit pas empecher le rapport.
Invoke-Safe 'update' { Update-Agent $resp.agentUpdate $token } | Out-Null
