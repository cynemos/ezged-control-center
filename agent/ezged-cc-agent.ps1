#Requires -Version 5.1
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
$AgentVersion = '0.1.2'
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
function Invoke-Safe([string]$Name, [scriptblock]$Block, $Default = $null) {
  try { & $Block } catch { Write-Log "WARN [$Name] $($_.Exception.Message)"; $Default }
}

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

$state = @{ lastInventory = $null; inventoryIntervalMin = 60 }
if (Test-Path $StateFile) {
  $s = Invoke-Safe 'state' { Get-Content $StateFile -Raw | ConvertFrom-Json }
  if ($s) {
    $state.lastInventory = $s.lastInventory
    if ($s.inventoryIntervalMin) { $state.inventoryIntervalMin = $s.inventoryIntervalMin }
    if ($s.docs) { $state.docs = $s.docs }
  }
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

function Get-ServiceStates {
  return @($Services | ForEach-Object {
      $svc = Get-Service -Name $_ -ErrorAction SilentlyContinue
      if ($svc) { [ordered]@{ name = $_; status = $svc.Status.ToString(); startType = $svc.StartType.ToString() } }
      else { [ordered]@{ name = $_; status = 'NotFound' } }
    })
}

# Strict : seuls 2xx/3xx/401/403 sont valides (page reellement servie).
# Sinon : toute reponse HTTP < 500 prouve que le processus ecoute (le serveur EzGED renvoie 404 sur /).
function Test-Http([string]$Url, [switch]$Strict) {
  $code = $null; $err = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Timeout = 10000
    $req.AllowAutoRedirect = $true
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

function Get-ApacheCertificates {
  $httpd = Join-Path $ApacheRoot 'conf\httpd.conf'
  if (-not (Test-Path $httpd)) { return @() }
  $resolve = { param($p) $p = $p.Trim('"').Replace('${SRVROOT}', $ApacheRoot).Replace('/', '\'); if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $ApacheRoot $p } }
  # httpd.conf + fichiers inclus (un niveau), lignes commentees ignorees.
  $files = @($httpd)
  foreach ($line in Get-Content $httpd) {
    if ($line -match '^\s*Include(?:Optional)?\s+(.+)$') {
      $files += @(Get-ChildItem -Path (& $resolve $Matches[1]) -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
    }
  }
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
$report = [ordered]@{
  agentVersion  = $AgentVersion
  hostname      = $env:COMPUTERNAME
  machineId     = Invoke-Safe 'machineId' { (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid }
  collectedAt   = ConvertTo-IsoDate (Get-Date)
  metrics       = Invoke-Safe 'metrics' { Get-Metrics }
  services      = @(Invoke-Safe 'services' { Get-ServiceStates } @())
  http          = Invoke-Safe 'http' {
    $port = (Read-IniKeys $EzgedConf @{ 'ezged.port' = 'port' }).port
    if (-not $port) { $port = '8080' }
    Test-Http "http://127.0.0.1:$port/"
  }
  web           = if ($WebUrl) { Invoke-Safe 'web' { Test-Http $WebUrl -Strict } } else { $null }
  backup        = Invoke-Safe 'backup' { Get-BackupState }
  queues        = Invoke-Safe 'queues' { Get-QueueStates }
  db            = Invoke-Safe 'db' { Get-DbState }
  pendingReboot = Invoke-Safe 'reboot' { Test-PendingReboot } $false
}

$inventoryDue = $ForceInventory -or -not $state.lastInventory -or
  (((Get-Date) - [datetime]$state.lastInventory).TotalMinutes -ge $state.inventoryIntervalMin)
if ($inventoryDue) {
  $report.inventory = Invoke-Safe 'inventory' { Get-Inventory }
}

$json = $report | ConvertTo-Json -Depth 8 -Compress

if ($DryRun) {
  $report | ConvertTo-Json -Depth 8
  return
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $token = Unprotect-Secret $cfg.tokenProtected
  $resp = Invoke-RestMethod -Method Post -Uri ($cfg.serverUrl.TrimEnd('/') + '/api/agent/report') `
    -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 30 -UseBasicParsing
  if ($inventoryDue -and $report.inventory) { $state.lastInventory = (Get-Date).ToString('o') }
  if ($resp.inventoryIntervalMin) { $state.inventoryIntervalMin = [int]$resp.inventoryIntervalMin }
  $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
} catch {
  Write-Log "ERROR envoi : $($_.Exception.Message)"
  exit 1
}
