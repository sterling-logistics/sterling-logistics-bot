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

function Add-UniquePath {
    param([System.Collections.Generic.List[string]]$List, [string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    $expanded = [Environment]::ExpandEnvironmentVariables($Path).Trim().Trim('"')
    if (-not $List.Contains($expanded)) { $List.Add($expanded) }
}

$steamRoots = New-Object System.Collections.Generic.List[string]
$steamRegistryPaths = @(
    'HKCU:\Software\Valve\Steam',
    'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam',
    'HKLM:\SOFTWARE\Valve\Steam'
)

foreach ($key in $steamRegistryPaths) {
    if (Test-Path $key) {
        $props = Get-ItemProperty $key -ErrorAction SilentlyContinue
        Add-UniquePath $steamRoots $props.SteamPath
        Add-UniquePath $steamRoots $props.InstallPath
    }
}

if (${env:ProgramFiles(x86)}) { Add-UniquePath $steamRoots "${env:ProgramFiles(x86)}\Steam" }
if ($env:ProgramFiles) { Add-UniquePath $steamRoots "$env:ProgramFiles\Steam" }

$steamLibraries = New-Object System.Collections.Generic.List[string]
foreach ($steamRoot in $steamRoots) {
    if (-not (Test-Path $steamRoot)) { continue }
    Add-UniquePath $steamLibraries $steamRoot

    $vdf = Join-Path $steamRoot 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        $content = Get-Content $vdf -Raw
        foreach ($match in [regex]::Matches($content, '"path"\s+"([^"]+)"')) {
            $library = $match.Groups[1].Value -replace '\\\\', '\'
            Add-UniquePath $steamLibraries $library
        }
    }
}

# Also inspect Steam app manifests. This catches custom library layouts even if
# libraryfolders.vdf formatting changes.
$gameAppIds = @('227300', '270880')
foreach ($steamRoot in @($steamRoots)) {
    if (-not (Test-Path $steamRoot)) { continue }
    $vdf = Join-Path $steamRoot 'steamapps\libraryfolders.vdf'
    if (-not (Test-Path $vdf)) { continue }
    $content = Get-Content $vdf -Raw
    foreach ($match in [regex]::Matches($content, '"path"\s+"([^"]+)"')) {
        Add-UniquePath $steamLibraries ($match.Groups[1].Value -replace '\\\\', '\')
    }
}

$gameFolders = @(
    @{ Name = 'Euro Truck Simulator 2'; AppId = '227300' },
    @{ Name = 'American Truck Simulator'; AppId = '270880' }
)

foreach ($library in $steamLibraries) {
    if (-not (Test-Path $library)) { continue }
    foreach ($game in $gameFolders) {
        $gameRoot = Join-Path $library "steamapps\common\$($game.Name)"
        $manifest = Join-Path $library "steamapps\appmanifest_$($game.AppId).acf"
        if (-not (Test-Path $gameRoot) -and -not (Test-Path $manifest)) { continue }
        if (-not (Test-Path $gameRoot)) { continue }

        $plugins = Join-Path $gameRoot 'bin\win_x64\plugins'
        New-Item -ItemType Directory -Path $plugins -Force | Out-Null
        $target = Join-Path $plugins 'scs-telemetry.dll'
        Copy-Item $plugin.FullName $target -Force

        if (-not (Test-Path $target)) {
            throw "Telemetry plugin copy failed: $target"
        }
        $sourceHash = (Get-FileHash $plugin.FullName -Algorithm SHA256).Hash
        $targetHash = (Get-FileHash $target -Algorithm SHA256).Hash
        if ($sourceHash -ne $targetHash) {
            throw "Telemetry plugin verification failed: $target"
        }
        $installed.Add($target)
    }
}

if ($installed.Count -eq 0) {
    throw 'ETS2/ATS Steam installation was not found. Sterling Tachograph cannot receive telemetry until the SCS plugin is installed.'
}

Write-Host 'Sterling telemetry plugin installed and verified:'
$installed | ForEach-Object { Write-Host " - $_" }
