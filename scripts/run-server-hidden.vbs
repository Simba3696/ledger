' Runs run-server.bat (in this same scripts\ folder) with a hidden window
' (0 = hidden, False = don't wait for it to exit, since it's a long-running
' server) — used by the "Ledger" Scheduled Task so the app starts silently
' at logon instead of popping up a visible console window.
' Self-locating via WScript.ScriptFullName, so this works regardless of
' where the repo is cloned — no path to edit per machine.
Dim fso, scriptDir, batPath
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\run-server.bat"

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """" & batPath & """", 0, False
