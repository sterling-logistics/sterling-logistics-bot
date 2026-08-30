#define MyAppName "Sterling Dispatch"
#define MyAppVersion "1.0.2"
#define MyAppPublisher "Sterling Logistics"
#define MyAppExeName "SterlingDispatch.exe"

[Setup]
AppId={{A9642DC3-A1B6-4C0B-9D06-8D4D8C74E390}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Sterling Logistics Dispatch and Staff Tracker
DefaultDirName={localappdata}\Programs\Sterling Logistics\Dispatch
DefaultGroupName=Sterling Logistics
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=SterlingDispatch-1.0.2-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Sterling Dispatch 1.0.2
CloseApplications=yes
RestartApplications=no

[Files]
Source: "..\publish\SterlingDispatch\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-telemetry.ps1"; DestDir: "{app}\Telemetry"; Flags: ignoreversion
Source: "..\build-assets\scs-telemetry.dll"; DestDir: "{app}\Telemetry"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Sterling Dispatch"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Sterling Dispatch"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Start Sterling Dispatch"; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM SterlingDispatch.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
