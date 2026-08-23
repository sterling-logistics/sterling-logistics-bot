#define MyAppName "Sterling Tracker"
#define MyAppVersion "3.0.9"
#define MyAppPublisher "Sterling Logistics"
#define MyAppExeName "SterlingTracker.exe"

[Setup]
AppId={{7F5C2513-11BA-4D19-A53C-53D28D3692B7}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Official Sterling Logistics ETS2 and ATS Tracker
DefaultDirName={localappdata}\Programs\Sterling Logistics\Tracker
DefaultGroupName=Sterling Logistics
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=SterlingTracker-3.0.9-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Sterling Tracker 3.0.9
CloseApplications=yes
RestartApplications=no

[Files]
Source: "..\publish\SterlingTracker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-telemetry.ps1"; DestDir: "{app}\Telemetry"; Flags: ignoreversion
Source: "..\build-assets\scs-telemetry.dll"; DestDir: "{app}\Telemetry"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Sterling Tracker"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Sterling Tracker"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "startup"; Description: "Start Sterling Tracker when I sign in to Windows"; GroupDescription: "Automatic tracking:"; Flags: checkedonce

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SterlingTracker"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Start Sterling Tracker"; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM SterlingTracker.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
