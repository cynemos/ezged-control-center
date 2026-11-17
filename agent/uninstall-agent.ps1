#Requires -RunAsAdministrator
# Supprime l'agent EzGed ControlCenter (tache planifiee + dossier ProgramData\EzGedControlCenter).
# Le serveur reste dans la console : supprimez-le depuis sa fiche si besoin.
$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'EzGed ControlCenter Agent' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $env:ProgramData 'EzGedControlCenter') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Agent EzGed ControlCenter desinstalle.'
