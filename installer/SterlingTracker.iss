#define MyAppName "Sterling Tracker"
#define MyAppVersion "2.1.0"
#define MyAppPublisher "Sterling Logistics"
#define MyAppExeName "SterlingTracker.exe"

[Setup]
AppId={{A76CC643-41B7-40D8-995D-40E3A098765A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription="Official Sterling Logistics ETS2 Driver Tracker"
DefaultDirName={localappdata}\Programs\Sterling Logistics\Tracker
DefaultGroupName=Sterling Logistics
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=SterlingTracker-2.1.0-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName="Sterling Tracker 2.1"
SetupIconFile=..\desktop\SterlingTracker.Desktop\Assets\SterlingTracker.ico
SetupLogging=yes
CloseApplications=yes
RestartApplications=no

[InstallDelete]
; Remove the obsolete localhost telemetry bridge from older builds.
Type: filesandordirs; Name: "{app}\Telemetry\TelemetryJsonService.exe"
Type: filesandordirs; Name: "{app}\Telemetry\TelemetryJsonService.dll"
Type: filesandordirs; Name: "{app}\Telemetry\TelemetryJsonService.deps.json"
Type: filesandordirs; Name: "{app}\Telemetry\TelemetryJsonService.runtimeconfig.json"

[Files]
Source: "..\publish\SterlingTracker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-telemetry.ps1"; DestDir: "{app}\Telemetry"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Sterling Tracker 2.1"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Sterling Tracker 2.1"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "startup"; Description: "Start Sterling Tracker when I sign into Windows"; GroupDescription: "Automatic tracking:"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SterlingTracker"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Telemetry\install-telemetry.ps1"" -PluginSource ""{app}\Telemetry\scs-telemetry.dll"""; StatusMsg: "Installing Sterling ETS2 telemetry..."; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Sterling Tracker 2.1"; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  { Make absolutely sure an older tracker/bridge cannot remain in memory while files are replaced. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM SterlingTracker.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM TelemetryJsonService.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
