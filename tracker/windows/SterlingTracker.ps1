param(
  [Parameter(Mandatory=$true)][string]$ApiBase,
  [Parameter(Mandatory=$true)][string]$TrackerKey
)

$ErrorActionPreference = 'Stop'
$TelemetryUrl = 'http://localhost:6969/'
$PostUrl = ($ApiBase.TrimEnd('/')) + '/api/tracker/telemetry'
$SessionCode = 'win-' + [guid]::NewGuid().ToString('N')
$headers = @{ Authorization = "Bearer $TrackerKey" }

function Get-Prop($obj, [string[]]$paths) {
  foreach ($path in $paths) {
    $cur = $obj
    $ok = $true
    foreach ($p in $path.Split('.')) {
      if ($null -eq $cur) { $ok = $false; break }
      $prop = $cur.PSObject.Properties[$p]
      if ($null -eq $prop) { $ok = $false; break }
      $cur = $prop.Value
    }
    if ($ok -and $null -ne $cur -and "$cur" -ne '') { return $cur }
  }
  return $null
}

function Send-Telemetry($eventType, $raw, $direct=$false) {
  $speed = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.Speed.Value','TruckValues.CurrentValues.Speed','speed')
  $truckMake = Get-Prop $raw @('TruckValues.ConstantsValues.Brand','TruckValues.ConstantsValues.Make','truck.make')
  $truckModel = Get-Prop $raw @('TruckValues.ConstantsValues.Model','truck.model')
  $cargo = Get-Prop $raw @('JobValues.CargoValues.Name','JobValues.Cargo','job.cargo')
  $src = Get-Prop $raw @('JobValues.CitySource','JobValues.SourceCity','job.sourceCity')
  $dst = Get-Prop $raw @('JobValues.CityDestination','JobValues.DestinationCity','job.destinationCity')
  $distanceKm = Get-Prop $raw @('JobValues.Delivered.DeliveryDistance','JobValues.JobDeliveredDistanceKm','job.distanceKm')
  $revenue = Get-Prop $raw @('JobValues.Delivered.Revenue','JobValues.JobDeliveredRevenue','job.revenue')

  $data = [ordered]@{
    game = (Get-Prop $raw @('Game'))
    speedMps = if ($null -ne $speed) { [double]$speed } else { 0 }
    truck = ((@($truckMake,$truckModel) | Where-Object { $_ }) -join ' ').Trim()
    cargo = $cargo
    sourceCity = $src
    destinationCity = $dst
    distanceKm = if ($null -ne $distanceKm) { [double]$distanceKm } else { 0 }
    revenue = if ($null -ne $revenue) { "$revenue" } else { '0' }
    raw = $raw
  }

  $body = @{
    sessionCode = $SessionCode
    status = 'online'
    eventType = $eventType
    directEvent = [bool]$direct
    data = $data
  } | ConvertTo-Json -Depth 30

  Invoke-RestMethod -Method Post -Uri $PostUrl -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
}

Write-Host 'Sterling Logistics Live Tracker'
Write-Host "Telemetry source: $TelemetryUrl"
Write-Host "Sterling API: $PostUrl"
Write-Host 'Start ETS2 and keep the Telemetry JSON Service running.'

$lastOnJob = $false
while ($true) {
  try {
    $raw = Invoke-RestMethod -Method Get -Uri $TelemetryUrl -TimeoutSec 3
    $onJob = [bool](Get-Prop $raw @('JobValues.OnJob','JobValues.JobActive','job.onJob'))
    $event = 'heartbeat'
    $direct = $false
    if ($onJob -and -not $lastOnJob) { $event='job-started'; $direct=$true }
    elseif (-not $onJob -and $lastOnJob) { $event='job-delivered'; $direct=$true }
    Send-Telemetry $event $raw $direct
    $lastOnJob = $onJob
    Write-Host ("[{0}] sent {1}" -f (Get-Date -Format 'HH:mm:ss'),$event)
  } catch {
    Write-Host ("[{0}] waiting for ETS2 telemetry: {1}" -f (Get-Date -Format 'HH:mm:ss'),$_.Exception.Message)
  }
  Start-Sleep -Seconds 10
}
