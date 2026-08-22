param(
  [string]$Destination = "../src/SterlingTracker/Vendor/SCSSdkClient"
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$dest = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Destination))
$temp = Join-Path $env:TEMP ("sterling-rencloud-" + [guid]::NewGuid().ToString('N'))
try {
  git clone --depth 1 --branch V.1.12.1 https://github.com/RenCloud/scs-sdk-plugin.git $temp
  if ($LASTEXITCODE -ne 0) { throw 'Could not clone RenCloud telemetry source.' }
  $source = Join-Path $temp 'scs-client\C#\SCSSdkClient'
  if (-not (Test-Path (Join-Path $source 'SCSSdkTelemetry.cs'))) { throw 'Pinned RenCloud source layout changed.' }
  Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem $source -Filter '*.cs' | Copy-Item -Destination $dest -Force
  Copy-Item (Join-Path $source 'Object') (Join-Path $dest 'Object') -Recurse -Force
  Copy-Item (Join-Path $temp 'LICENSE') (Join-Path $dest 'RENCloud-LICENSE.txt') -Force
  Write-Host "RenCloud V.1.12.1 telemetry client prepared at $dest"
}
finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
