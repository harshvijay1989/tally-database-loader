; ============================================================================
;  Tally -> Salesforce Connector  -  Inno Setup script
;
;  Produces a self-contained per-user installer. The target machine needs
;  NOTHING pre-installed: a portable Node.js runtime is bundled. All
;  connections (Salesforce, Google) are configured from the UI at runtime.
;
;  Build via installer\build.ps1 (which stages installer\build\payload and
;  passes /DMyAppVersion). Do not run ISCC on this file directly unless the
;  payload folder has already been staged.
; ============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#define MyAppName    "Tally to Salesforce Connector"
#define MyAppExeName "start-connector.bat"
#define MyAppPublisher "Tally to Salesforce"

[Setup]
AppId={{9F2C7B14-4D3A-4E1C-9A77-TALLY2SFCONN}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Per-user install: no administrator rights needed, and the install folder is
; writable at runtime (the app stores mappings, extracted data and logs there).
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\Tally Salesforce Connector
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\node\node.exe
OutputDir=build
OutputBaseFilename=TallySalesforceConnector-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
; The full staged app: dist, production node_modules, webui, portable node
; runtime, config files and the launcher.
Source: "build\payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}";        Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"; Tasks: desktopicon

[Run]
; Offer to launch right after install.
Filename: "{app}\{#MyAppExeName}"; Description: "Start the connector now"; WorkingDir: "{app}"; Flags: shellexec nowait postinstall skipifsilent

[Code]
// On uninstall, ask whether to also remove runtime data the app created itself
// (connections.json holds credentials; mappings are the user's saved work). The
// installer does not track these files, so without this they would be left behind.
procedure CurUninstallStepChanged(CurStep: TUninstallStep);
begin
  if CurStep = usPostUninstall then
  begin
    if MsgBox('Do you also want to delete your saved connections (including Salesforce and Google credentials) and your saved mappings?'
              + #13#10 + #13#10 + 'Click No to keep them for a future reinstall.',
              mbConfirmation, MB_YESNO) = IDYES then
    begin
      DeleteFile(ExpandConstant('{app}\connections.json'));
      DeleteFile(ExpandConstant('{app}\salesforce-credentials.json'));
      DeleteFile(ExpandConstant('{app}\import-log.txt'));
      DeleteFile(ExpandConstant('{app}\error-log.txt'));
      DelTree(ExpandConstant('{app}\mappings'), True, True, True);
      DelTree(ExpandConstant('{app}\csv'), True, True, True);
      RemoveDir(ExpandConstant('{app}'));
    end;
  end;
end;
