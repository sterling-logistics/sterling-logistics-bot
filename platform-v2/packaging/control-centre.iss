#define MyAppName "Sterling Control Centre"
#define MyAppVersion "2.0.0-alpha.2"
#define MyAppPublisher "Sterling Logistics"
#define MyAppExeName "SterlingControlCentre.exe"

[Setup]
AppId={{DE67A17B-6E50-4E3E-9D2C-2AE491653C84}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Sterling Logistics\Control Centre
DefaultGroupName=Sterling Logistics
OutputDir=output
OutputBaseFilename=Sterling-Control-Centre-2.0.0-alpha.2-Setup
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
Source: "publish\control-centre\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Sterling Control Centre"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Sterling Control Centre"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Sterling Control Centre"; Flags: nowait postinstall skipifsilent
