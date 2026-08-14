#define MyAppName "Sterling Tracker"
#define MyAppVersion "1.1.0"
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
OutputBaseFilename=SterlingTrackerSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName="Sterling Tracker"
SetupLogging=yes

[Files]
Source: "..\publish\SterlingTracker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Sterling Tracker"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Sterling Tracker"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "startup"; Description: "Start Sterling Tracker when I sign into Windows"; GroupDescription: "Automatic tracking:"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SterlingTracker"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Sterling Tracker"; Flags: nowait postinstall skipifsilent
