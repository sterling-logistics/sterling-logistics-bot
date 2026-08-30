#define MyAppName "Sterling Tachograph"
#define MyAppVersion "2.0.0-alpha.3"
#define MyAppPublisher "Sterling Logistics"
#define MyAppExeName "SterlingTracker.exe"

[Setup]
AppId={{5A7E35D6-EA31-4D42-BE7B-1C61E21352D4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Sterling Logistics\Tachograph
DefaultGroupName=Sterling Logistics
OutputDir=output
OutputBaseFilename=Sterling-Tachograph-2.0.0-alpha.3-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
RestartApplications=no

[Files]
Source: "publish\tracker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "payload\telemetry\*"; DestDir: "{app}\TelemetryPlugin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "Install-TelemetryPlugin.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion

[Icons]
Name: "{group}\Sterling Tachograph"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Sterling Tachograph"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked
Name: "startup"; Description: "Start Sterling Tachograph when I sign in to Windows"; GroupDescription: "Background operation:"; Flags: checkedonce

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SterlingTachograph"; ValueData: """{app}\{#MyAppExeName}"""; Tasks: startup; Flags: uninsdeletevalue

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Tools\Install-TelemetryPlugin.ps1"" -PluginPath ""{app}\TelemetryPlugin\scs-telemetry.dll"""; StatusMsg: "Installing Sterling telemetry plugin for ETS2/ATS..."; Flags: runhidden waituntilterminated; Check: FileExists(ExpandConstant('{app}\TelemetryPlugin\scs-telemetry.dll'))
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Sterling Tachograph"; Flags: nowait postinstall skipifsilent
