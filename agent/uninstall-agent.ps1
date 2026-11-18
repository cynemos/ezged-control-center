#Requires -RunAsAdministrator
# Supprime l'agent EzGed ControlCenter (tache planifiee + dossier ProgramData\EzGedControlCenter).
# Le serveur reste dans la console : supprimez-le depuis sa fiche si besoin.
# schtasks plutot que Unregister-ScheduledTask, absent de Server 2008 R2.
& schtasks.exe /Delete /TN 'EzGed ControlCenter Agent' /F 2>&1 | Out-Null
Remove-Item -Path (Join-Path $env:ProgramData 'EzGedControlCenter') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Agent EzGed ControlCenter desinstalle.'
