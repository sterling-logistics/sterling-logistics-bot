param([Parameter(Mandatory=$true)][string]$PluginSource)
$ErrorActionPreference='Stop'
if(-not (Test-Path $PluginSource)){throw "Telemetry plugin not found: $PluginSource"}

$steamRoots = New-Object System.Collections.Generic.List[string]
try {
  $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath
  if($steam){$steamRoots.Add($steam)}
} catch {}
$steamRoots.Add('C:\Program Files (x86)\Steam')
$steamRoots.Add('C:\Program Files\Steam')

$libraries = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
foreach($root in $steamRoots){
  if(-not (Test-Path $root)){continue}
  [void]$libraries.Add($root)
  $vdf=Join-Path $root 'steamapps\libraryfolders.vdf'
  if(Test-Path $vdf){
    $raw=Get-Content $vdf -Raw
    foreach($m in [regex]::Matches($raw,'"path"\s+"([^"]+)"')){
      $p=$m.Groups[1].Value -replace '\\\\','\'
      if($p){[void]$libraries.Add($p)}
    }
  }
}

$targets=@()
foreach($lib in $libraries){
  $game=Join-Path $lib 'steamapps\common\Euro Truck Simulator 2'
  if(Test-Path $game){$targets += $game}
}
if(-not $targets){throw 'Euro Truck Simulator 2 was not found in your Steam libraries. Install ETS2 in Steam, then run this again.'}

foreach($game in $targets){
  $dest=Join-Path $game 'bin\win_x64\plugins'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item $PluginSource (Join-Path $dest 'scs-telemetry.dll') -Force
  Write-Host "Installed Sterling telemetry plugin to $dest"
}
Write-Host 'Done. Fully close and restart Euro Truck Simulator 2.'
