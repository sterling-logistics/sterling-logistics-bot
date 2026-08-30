param(
    [Parameter(Mandatory = $true)]
    [string]$PluginPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $PluginPath)) {
    throw "Telemetry plugin not found: $PluginPath"
}

$plugin = Get-Item $PluginPath
$installed = New-Object System.Collections.Generic.List[string]

function Add-CandidatePath {
    param([System.Collections.Generic.List[string]]$List, [string]$Path)
    if (-not [string]::IsNullOrWhiteSpace($Path) -and -not $List.Contains($Path)) {
        $List.Add($Path)
    }
}

$candidates = New-Object System.Collections.Generic.List[string]

$steamRegistryPaths = @(
    'HKCU:\Software\Valve\Steam',
    'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam',
    'HKLM:\SOFTWARE\Valve\Steam'
)

foreach ($key in $steamRegistryPaths) {
    if (Test-Path $key) {
        $props = Get-ItemProperty $key -ErrorAction SilentlyContinue
        Add-CandidatePath $candidates $props.SteamPath
        Add-CandidatePath $candidates $props.InstallPath
    }
}

Add-CandidatePath $candidates "$env:ProgramFiles(x86)\Steam"
Add-CandidatePath $candidates "$env:ProgramFiles\Steam"

$steamLibraries = New-Object System.Collections.Generic.List[string]
foreach ($steamRoot in $candidates) {
    if (-not (Test-Path $steamRoot)) { continue }
    Add-CandidatePath $steamLibraries $steamRoot

    $vdf = Join-Path $steamRoot 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        $content = Get-Content $vdf -Raw
        foreach ($match in [regex]::Matches($content, '"path"\s+"([^"]+)"')) {
            $library = $match.Groups[1].Value -replace '\\\\', '\'
            Add-CandidatePath $steamLibraries $library
        }
    }
}

$gameFolders = @(
    'Euro Truck Simulator 2',
    'American Truck Simulator'
)

foreach ($library in $steamLibraries) {
    foreach ($game in $gameFolders) {
        $gameRoot = Join-Path $library "steamapps\common\$game"
        if (-not (Test-Path $gameRoot)) { continue }

        $plugins = Join-Path $gameRoot 'bin\win_x64\plugins'
        New-Item -ItemType Directory -Path $plugins -Force | Out-Null
        $target = Join-Path $plugins $plugin.Name
        Copy-Item $plugin.FullName $target -Force
        $installed.Add($target)
    }
}

if ($installed.Count -eq 0) {
    Write-Warning 'ETS2/ATS installation was not found automatically. The Tracker is installed, but telemetry plugin installation still needs a detected Steam game folder.'
    exit 2
}

Write-Host 'Sterling telemetry plugin installed:'
$installed | ForEach-Object { Write-Host " - $_" }
