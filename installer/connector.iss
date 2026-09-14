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
#ifndef Variant
  #define Variant ""
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
OutputBaseFilename=TallySalesforceConnector-Setup-{#MyAppVersion}{#Variant}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
; Auto-start is what keeps the self-running sync scheduler alive without anyone
; launching the app. Checked by default; runs silently at sign-in (no window).
Name: "autostart"; Description: "Start the connector automatically when I sign in (keeps scheduled syncs running)"; GroupDescription: "Auto-start:"

[Files]
; The full staged app: dist, production node_modules, webui, portable node
; runtime, config files and the launcher.
Source: "build\payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}";        Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"; Tasks: desktopicon
; Silent auto-start at sign-in (per-user Startup folder) -> runs start-connector-hidden.vbs.
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\start-connector-hidden.vbs"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"; Tasks: autostart

[Run]
; Offer to launch right after install.
Filename: "{app}\{#MyAppExeName}"; Description: "Start the connector now"; WorkingDir: "{app}"; Flags: shellexec nowait postinstall skipifsilent

[Code]
// Registry key Inno writes for this AppId on a per-user (lowest privilege) install.
const
  UninstKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{9F2C7B14-4D3A-4E1C-9A77-TALLY2SFCONN}_is1';

function StripQuotes(S: String): String;
begin
  Result := S;
  if (Length(Result) >= 2) and (Result[1] = '"') then
    Result := Copy(Result, 2, Length(Result) - 1);
  if (Length(Result) >= 1) and (Result[Length(Result)] = '"') then
    Result := Copy(Result, 1, Length(Result) - 1);
end;

// If a previous install is found, let the user choose: update in place, or
// uninstall+remove, or cancel. A fresh machine skips straight to the wizard.
function InitializeSetup(): Boolean;
var
  oldVer, uninstall: String;
  choice, ec: Integer;
begin
  Result := True;
  if not RegQueryStringValue(HKCU, UninstKey, 'DisplayVersion', oldVer) then
    RegQueryStringValue(HKLM, UninstKey, 'DisplayVersion', oldVer); // just in case of a machine-wide install
  if oldVer = '' then
    Exit; // nothing installed — continue normally

  choice := MsgBox('Tally to Salesforce Connector ' + oldVer + ' is already installed.'
      + #13#10 + #13#10
      + 'Yes  =  Update to version {#MyAppVersion}' + #13#10
      + 'No   =  Uninstall and remove it' + #13#10
      + 'Cancel  =  Exit without changes',
      mbConfirmation, MB_YESNOCANCEL);

  if choice = IDYES then
  begin
    Result := True; // same AppId -> Inno installs over the top (in-place update)
  end
  else if choice = IDNO then
  begin
    // run the existing uninstaller interactively (so its "remove your data?" prompt shows), then exit
    if not RegQueryStringValue(HKCU, UninstKey, 'UninstallString', uninstall) then
      RegQueryStringValue(HKLM, UninstKey, 'UninstallString', uninstall);
    if uninstall <> '' then
      Exec(StripQuotes(uninstall), '', '', SW_SHOW, ewWaitUntilTerminated, ec)
    else
      MsgBox('Could not locate the existing uninstaller.', mbError, MB_OK);
    Result := False; // do not proceed to install after uninstalling
  end
  else
    Result := False; // Cancel
end;

// Before copying files (fresh install or update), stop any running connector so its
// node.exe / dist files aren't locked. Targets only the node.exe launched from THIS
// install folder — never touches other Node apps on the machine.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ec: Integer;
  ps, q: String;
begin
  Result := '';
  NeedsRestart := False;
  q := ''''; // a single-quote character
  ps := '-NoProfile -ExecutionPolicy Bypass -Command "'
      + 'Get-Process node -ErrorAction SilentlyContinue | '
      + 'Where-Object { $_.Path -like ' + q + ExpandConstant('{app}') + '\node\*' + q + ' } | '
      + 'Stop-Process -Force -ErrorAction SilentlyContinue"';
  Exec('powershell.exe', ps, '', SW_HIDE, ewWaitUntilTerminated, ec);
  Sleep(500); // let file handles release before the copy begins
end;

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
