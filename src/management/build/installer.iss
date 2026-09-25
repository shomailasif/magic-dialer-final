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
AppVersion=1.4.15
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
  { Upgrades must stop the watchdog/agent before replacing agent.exe.
    No /T on either taskkill: this setup process was spawned by the agent, so
    killing the agent's child tree takes down the installer itself. The real
    evidence: a self-update's setup log stopped dead between RestartManager
    and the first file entry, left is-*.tmp behind, wrote no crash event, and
    the agent processes were still alive at that instant - whereas an update
    whose launching agent had already exited survived the same line. Both
    agent.exe processes are matched by image name anyway, so /T bought
    nothing and cost the whole install. }
  Exec(ExpandConstant('{cmd}'), '/d /c taskkill /F /IM MagicDialer.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{cmd}'), '/d /c taskkill /F /IM agent.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { A source-tree or orphaned node agent can hold 18787/48787 and block the
    replacement engine. Kill any node process running agent.js. }
  Exec(ExpandConstant('{cmd}'), '/d /c powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $_.CommandLine -match ''agent\.js'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { Forced termination cannot run watchdog cleanup. Once agent.exe is gone,
    its PID-only lock is stale and must not block the replacement watchdog. }
  DeleteFile(ExpandConstant('{localappdata}\Magic Dialer\watchdog.lock'));
  Sleep(750);
end;

function AgentRunning(): Boolean;
var ResultCode: Integer;
begin
  { Cheap gate first: in the normal case there is nothing called agent.exe at
    all and this costs one tasklist. findstr exits 0 only on a real match, so
    the exit code is the whole test. }
  Result := Exec(ExpandConstant('{cmd}'),
    '/d /c tasklist /FI "IMAGENAME eq agent.exe" | findstr /I "agent.exe" >nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then exit;
  { Some other product also ships agent.exe. Confirm the process is the copy
    we just installed, otherwise we would wave a lost update through. }
  Result := Exec(ExpandConstant('{cmd}'),
    '/d /c powershell -NoProfile -NonInteractive -Command "if (Get-Process -Name agent -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq ''' +
    ExpandConstant('{app}\agent.exe') +
    ''' }) { exit 0 } else { exit 1 }"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure EnsureAgentSupervised();
var
  i: Integer;
  Attempts: Integer;
  LaunchResult: Integer;
  StopResult: Integer;
begin
  if FileExists(ExpandConstant('{app}\agent.exe')) then
    Log('setup: post-install supervision check; agent.exe present')
  else
    Log('setup: WARNING agent.exe is missing from {app}');

  { StopRunningMagicDialer ran at ssInstall, but Inno's RestartManager pass
    runs after the [Run] entry and revives the node process it found holding
    our files. That revived process can own 18787/48771, so the freshly
    spawned engine never becomes ready and the launcher walks away. }
  Exec(ExpandConstant('{cmd}'), '/d /c powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $_.CommandLine -match ''agent\.js'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', '', SW_HIDE, ewWaitUntilTerminated, StopResult);

  { StopRunningMagicDialer killed watchdog+agent at ssInstall, and the [Run]
    entry is nowait: it hands MagicDialer control and moves straight on. The
    launcher now retries for ~4 minutes, so give it that long before concluding. }
  for i := 1 to 45 do begin
    if AgentRunning() then exit;
    Sleep(1000);
  end;
  { Still nothing. If the one spawn [Run] attempted is ever lost, nothing else
    on this machine brings the agent back until the next logon — the exact
    failure an unattended upgrade cannot be allowed to ship. Do it ourselves. }
  for Attempts := 1 to 3 do begin
    Log('setup: no agent process after install (attempt ' + IntToStr(Attempts) +
        '); relaunching supervisor');
    { We only get here when no agent.exe exists, so any supervisor lock is by
      definition stale. A stale lock that names a recycled PID is precisely
      what makes every relaunch start and immediately resign — clear it. }
    DeleteFile(ExpandConstant('{localappdata}\Magic Dialer\watchdog.lock'));
    { nowait on purpose: the observed outage outlived the installer, so the
      relaunch must outlive it too. Its own launcher.log records the outcome. }
    if not Exec(ExpandConstant('{app}\MagicDialer.exe'), '--no-browser',
                ExpandConstant('{app}'), SW_HIDE, ewNoWait, LaunchResult) then begin
      Log('setup: relaunch failed to start');
      break;
    end;
    Log('setup: relaunch started (runs beyond setup; see launcher.log)');
    for i := 1 to 10 do begin
      Sleep(1000);
      if AgentRunning() then exit;
    end;
  end;
  Log('setup: WARNING — agent still not running after supervised relaunches');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var CacheDir, CacheFile: string;
begin
  if CurStep = ssInstall then
    StopRunningMagicDialer();

  if CurStep = ssPostInstall then begin
    CacheDir := ExpandConstant('{localappdata}\\Magic Dialer\\updates');
    ForceDirectories(CacheDir);
    CacheFile := CacheDir + '\\known-good-1.4.15.exe';
    if not FileExists(CacheFile) then
      FileCopy(ExpandConstant('{srcexe}'), CacheFile, False);
  end;

  { Last thing we do. If the supervisor is gone, nothing else on this machine
    will bring the agent back until the next logon — so we prove it ourselves. }
  if CurStep = ssDone then
    EnsureAgentSupervised();
end;

[Run]
; Open the local engine dashboard. Account pairing is performed securely from
; the customer's authenticated web portal via "Connect This PC"; no access key
; is entered or copied by the customer.
Filename: "{app}\MagicDialer.exe"; Flags: nowait skipifsilent; Description: "Launch Magic Dialer"
; Background auto-updates run very silently and deliberately stop the old
; watchdog before replacing agent.exe. Restart supervision without opening UI.
Filename: "{app}\MagicDialer.exe"; Parameters: "--no-browser"; Flags: nowait skipifnotsilent
