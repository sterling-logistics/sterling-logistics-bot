#define MyAppName "Sterling Logistics Tracker"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Sterling Logistics"
#define MyAppExeName "SterlingTracker.exe"

[Setup]
AppId={{A76CC643-41B7-40D8-995D-40E3A098765A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Sterling Logistics\Tracker
DefaultGroupName=Sterling Logistics
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=SterlingTrackerSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "..\publish\SterlingTracker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Sterling Logistics Tracker"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Sterling Logistics Tracker"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "startup"; Description: "Start Sterling Tracker when I sign into Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SterlingTracker"; ValueData: "{app}\{#MyAppExeName}"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Sterling Logistics Tracker"; Flags: nowait postinstall skipifsilent
