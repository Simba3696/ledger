' Runs run-server.bat with a hidden window (0 = hidden, False = don't wait
' for it to exit, since it's a long-running server) — used by the "Ledger"
' Scheduled Task so the app starts silently at logon instead of popping up
' a visible console window.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """D:\codebase\personal\ledger\scripts\run-server.bat""", 0, False
