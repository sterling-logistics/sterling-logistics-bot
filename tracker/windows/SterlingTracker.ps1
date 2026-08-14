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
  $fuel = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.FuelValue.Amount','TruckValues.CurrentValues.Fuel','truck.fuel')
  $odometer = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.Odometer','TruckValues.CurrentValues.Odometer','truck.odometer')
  $truckDamage = Get-Prop $raw @('TruckValues.CurrentValues.DamageValues.Truck','TruckValues.CurrentValues.Damage.Truck','truck.damage')
  $trailerDamage = Get-Prop $raw @('TrailerValues.Damage','TrailerValues.CurrentValues.Damage','trailer.damage')
  $cargoDamage = Get-Prop $raw @('JobValues.CargoValues.Damage','JobValues.CargoDamage','job.cargoDamage')
  $engineOn = Get-Prop $raw @('TruckValues.CurrentValues.LightsValues.EngineEnabled','TruckValues.CurrentValues.EngineEnabled','truck.engineOn')
  $lat = Get-Prop $raw @('TruckValues.CurrentValues.Position.X','truck.position.x','position.x')
  $lon = Get-Prop $raw @('TruckValues.CurrentValues.Position.Z','truck.position.z','position.z')
  $rpm = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.RPM.Value','TruckValues.CurrentValues.RPM','truck.rpm')

  $data = [ordered]@{
    game = (Get-Prop $raw @('Game'))
    speedMps = if ($null -ne $speed) { [double]$speed } else { 0 }
    truck = ((@($truckMake,$truckModel) | Where-Object { $_ }) -join ' ').Trim()
    cargo = $cargo
    sourceCity = $src
    destinationCity = $dst
    distanceKm = if ($null -ne $distanceKm) { [double]$distanceKm } else { 0 }
    revenue = if ($null -ne $revenue) { "$revenue" } else { '0' }
    fuelLiters = if ($null -ne $fuel) { [double]$fuel } else { 0 }
    odometerKm = if ($null -ne $odometer) { [double]$odometer } else { 0 }
    truckDamage = if ($null -ne $truckDamage) { [double]$truckDamage } else { 0 }
    trailerDamage = if ($null -ne $trailerDamage) { [double]$trailerDamage } else { 0 }
    cargoDamage = if ($null -ne $cargoDamage) { [double]$cargoDamage } else { 0 }
    engineOn = if ($null -ne $engineOn) { [bool]$engineOn } else { $false }
    engineRpm = if ($null -ne $rpm) { [double]$rpm } else { 0 }
    latitude = if ($null -ne $lat) { [double]$lat } else { $null }
    longitude = if ($null -ne $lon) { [double]$lon } else { $null }
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
Write-Host 'Tracking hours, driving time, fuel, damage, jobs and live status.'

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
