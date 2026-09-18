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
AppVersion=1.2.0
DefaultDirName={localappdata}\Magic Dialer
DefaultGroupName=Magic Dialer
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=MagicDialer-Setup
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
Source: "assets\logo-256.png"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\logo.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userstartup}\Magic Dialer"; Filename: "{app}\MagicDialer.exe"; IconFilename: "{app}\logo.ico"; WorkingDir: "{app}"
Name: "{commondesktop}\Magic Dialer"; Filename: "{app}\MagicDialer.exe"; IconFilename: "{app}\logo.ico"; WorkingDir: "{app}"
Name: "{group}\Magic Dialer"; Filename: "{app}\MagicDialer.exe"; IconFilename: "{app}\logo.ico"; WorkingDir: "{app}"

[Run]
; Open the app window: the agent runs its dashboard locally and the customer
; completes the one-time setup right there (portal URL + access key).
Filename: "{app}\MagicDialer.exe"; Flags: nowait skipifsilent; Description: "Launch Magic Dialer"
