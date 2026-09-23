; Magic Dialer Installer
; Inno Setup script — free (uses Inno Setup, free; and the packaged agent .exe).
;
; This wraps the customer's PC agent into a single .exe. It:
;   1. installs the agent to %LocalAppData%\Magic Dialer
;      (per-user only — no admin needed, no elevation/path issues)
;   2. launches the agent, which opens its own built-in dashboard window
;      (a chrome-less app window via Edge --app on 127.0.0.1) where the
;      customer completes the one-time setup — no PowerShell is shown
;
; Build: ISCC.exe installer.iss   (requires dist\MagicDialer.exe — see BUILD.md)

[Setup]
AppName=Magic Dialer
AppVersion=1.4.1
DefaultDirName={localappdata}\Magic Dialer
DefaultGroupName=Magic Dialer
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=magic-dialer-engine-windows
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Magic Dialer
UninstallDisplayIcon={app}\logo.ico
SetupIconFile=assets\logo.ico
WizardStyle=modern

[Files]
; The engine (hidden console agent - spawned by the launcher, never seen) and
; the real corporate GUI launcher the customer clicks. Both must ship.
Source: "dist\agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\MagicDialer.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "assets\logo-256.png"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\logo.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Magic Dialer"; Filename: "{app}\MagicDialer.exe"; IconFilename: "{app}\logo.ico"; WorkingDir: "{app}"
Name: "{userdesktop}\Magic Dialer"; Filename: "{app}\MagicDialer.exe"; IconFilename: "{app}\logo.ico"; WorkingDir: "{app}"

[Registry]
; Auto-start via Run key (works on all Windows, no shortcut permissions needed)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Magic Dialer"; ValueData: """{app}\MagicDialer.exe"" --no-browser"; Flags: uninsdeletevalue

[Code]
procedure StopRunningMagicDialer();
var ResultCode: Integer;
begin
  { Upgrades must stop the watchdog/agent before replacing agent.exe. }
  Exec(ExpandConstant('{cmd}'), '/d /c taskkill /F /IM MagicDialer.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{cmd}'), '/d /c taskkill /F /IM agent.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { Forced termination cannot run watchdog cleanup. Once agent.exe is gone,
    its PID-only lock is stale and must not block the replacement watchdog. }
  DeleteFile(ExpandConstant('{localappdata}\Magic Dialer\watchdog.lock'));
  Sleep(750);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var CacheDir, CacheFile: string;
begin
  if CurStep = ssInstall then
    StopRunningMagicDialer();

  if CurStep = ssPostInstall then begin
    CacheDir := ExpandConstant('{localappdata}\\Magic Dialer\\updates');
    ForceDirectories(CacheDir);
    CacheFile := CacheDir + '\\known-good-1.4.1.exe';
    if not FileExists(CacheFile) then
      FileCopy(ExpandConstant('{srcexe}'), CacheFile, False);
  end;
end;

[Run]
; Open the local engine dashboard. Account pairing is performed securely from
; the customer's authenticated web portal via "Connect This PC"; no access key
; is entered or copied by the customer.
Filename: "{app}\MagicDialer.exe"; Flags: nowait skipifsilent; Description: "Launch Magic Dialer"
; Background auto-updates run very silently and deliberately stop the old
; watchdog before replacing agent.exe. Restart supervision without opening UI.
Filename: "{app}\MagicDialer.exe"; Parameters: "--no-browser"; Flags: nowait skipifnotsilent
