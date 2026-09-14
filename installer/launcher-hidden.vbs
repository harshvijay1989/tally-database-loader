' ---------------------------------------------------------------------------
'  Tally -> Salesforce Connector — silent auto-start launcher.
'  Installed as start-connector-hidden.vbs and pointed to by a Startup-folder
'  shortcut, so the connector (and its self-running sync scheduler) starts in the
'  background at sign-in — no console window, no browser popup. The interactive
'  start-connector.bat is still used for the desktop/Start-menu icon.
'
'  If the connector is already running, it exits on its own (port in use), so a
'  second launch here is harmless.
' ---------------------------------------------------------------------------
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Environment("PROCESS")("NO_OPEN") = "1"   ' don't open a browser on the silent start
' Window style 0 = hidden, do not wait.
sh.Run """" & dir & "\node\node.exe"" """ & dir & "\dist\uiServer.mjs""", 0, False
