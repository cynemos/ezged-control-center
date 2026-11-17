#Requires -Version 5.1
<#
  Lance la console EzGed ControlCenter et la relance si elle s'arrete.
  Execute par la tache planifiee "EzGed ControlCenter Console" (compte SYSTEM, au demarrage).
#>
$Dir = $PSScriptRoot
$Node = Join-Path $Dir 'node\node.exe'
$LogDir = Join-Path $Dir 'logs'
$Log = Join-Path $LogDir 'console.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location (Join-Path $Dir 'app\server')

while ($true) {
  if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 20MB) { Move-Item $Log "$Log.1" -Force }
  & cmd.exe /c "`"$Node`" dist\index.js >> `"$Log`" 2>&1"
  Add-Content -Path $Log -Value ("{0} console arretee (code {1}), relance dans 10 s" -f (Get-Date -Format s), $LASTEXITCODE)
  Start-Sleep -Seconds 10
}
