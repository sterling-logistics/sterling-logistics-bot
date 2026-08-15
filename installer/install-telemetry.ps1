param(
  [Parameter(Mandatory=$true)][string]$PluginSource
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $PluginSource)) {
  throw "Telemetry plugin not found: $PluginSource"
}

$steamRoots = New-Object System.Collections.Generic.List[string]

function Add-SteamRoot([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return }
  $clean = $path.Trim().Trim('"').Replace('/', '\')
  if (Test-Path $clean) {
    if (-not $steamRoots.Contains($clean)) { $steamRoots.Add($clean) }
  }
}

try { Add-SteamRoot ((Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath) } catch {}
try { Add-SteamRoot ((Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction Stop).InstallPath) } catch {}
try { Add-SteamRoot ((Get-ItemProperty 'HKLM:\SOFTWARE\Valve\Steam' -ErrorAction Stop).InstallPath) } catch {}
Add-SteamRoot "$env:ProgramFiles(x86)\Steam"
Add-SteamRoot "$env:ProgramFiles\Steam"

$libraryRoots = New-Object System.Collections.Generic.List[string]
foreach ($steamRoot in @($steamRoots)) {
  if (-not $libraryRoots.Contains($steamRoot)) { $libraryRoots.Add($steamRoot) }
  $vdf = Join-Path $steamRoot 'steamapps\libraryfolders.vdf'
  if (Test-Path $vdf) {
    foreach ($line in Get-Content $vdf) {
      if ($line -match '"path"\s+"([^"]+)"') {
        $lib = $matches[1].Replace('\\','\')
        if ((Test-Path $lib) -and -not $libraryRoots.Contains($lib)) { $libraryRoots.Add($lib) }
      }
    }
  }
}

$installed = $false
foreach ($root in @($libraryRoots)) {
  $game = Join-Path $root 'steamapps\common\Euro Truck Simulator 2'
  if (-not (Test-Path $game)) { continue }
  $plugins = Join-Path $game 'bin\win_x64\plugins'
  New-Item -ItemType Directory -Force -Path $plugins | Out-Null
  Copy-Item -Path $PluginSource -Destination (Join-Path $plugins 'scs-telemetry.dll') -Force
  $installed = $true
}

if (-not $installed) {
  Write-Warning 'Euro Truck Simulator 2 was not found in the detected Steam libraries. Sterling Tracker can still be installed, but telemetry will remain unavailable until ETS2 is installed.'
  exit 0
}

Write-Host 'Sterling ETS2 telemetry plugin installed successfully.'
