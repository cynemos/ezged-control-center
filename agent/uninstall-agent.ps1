#Requires -RunAsAdministrator
# Supprime l'agent EzMon (tache planifiee + dossier ProgramData\EzMon).
# Le serveur reste dans la console : supprimez-le depuis sa fiche si besoin.
$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'EzMon Agent' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $env:ProgramData 'EzMon') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Agent EzMon desinstalle.'
