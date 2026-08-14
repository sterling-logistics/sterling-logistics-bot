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

function As-Double($v) {
  if ($null -eq $v) { return 0.0 }
  try { return [double]$v } catch { return 0.0 }
}

function As-Bool($v) {
  if ($null -eq $v) { return $false }
  try { return [bool]$v } catch { return $false }
}

function Max-Damage($raw) {
  $values = @(
    As-Double (Get-Prop $raw @('TruckValues.CurrentValues.DamageValues.Body')),
    As-Double (Get-Prop $raw @('TruckValues.CurrentValues.DamageValues.Chassis')),
    As-Double (Get-Prop $raw @('TruckValues.CurrentValues.DamageValues.Engine')),
    As-Double (Get-Prop $raw @('TruckValues.CurrentValues.DamageValues.Transmission')),
    As-Double (Get-Prop $raw @('TruckValues.CurrentValues.DamageValues.Cabin')),
    As-Double (Get-Prop $raw @('TruckValues.CurrentValues.DamageValues.WheelsAvg'))
  )
  return ($values | Measure-Object -Maximum).Maximum
}

function Send-Telemetry($eventType, $raw, $direct=$false) {
  $speed = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.Speed.Value','TruckValues.CurrentValues.DashboardValues.Speed.Kph')
  $speedIsKph = $null -eq (Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.Speed.Value'))
  $speedMps = As-Double $speed
  if ($speedIsKph) { $speedMps = $speedMps / 3.6 }

  $truckMake = Get-Prop $raw @('TruckValues.ConstantsValues.Brand')
  $truckModel = Get-Prop $raw @('TruckValues.ConstantsValues.Name','TruckValues.ConstantsValues.Model')
  $cargo = Get-Prop $raw @('JobValues.CargoValues.Name')
  $src = Get-Prop $raw @('JobValues.CitySource')
  $dst = Get-Prop $raw @('JobValues.CityDestination')
  $distanceKm = Get-Prop $raw @('GamePlay.JobDelivered.DistanceKm','JobValues.PlannedDistanceKm')
  $revenue = Get-Prop $raw @('GamePlay.JobDelivered.Revenue','JobValues.Income')
  $fuel = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.FuelValue.Amount')
  $odometer = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.Odometer')
  $truckDamage = Max-Damage $raw
  $trailerDamage = Get-Prop $raw @('TrailerValues.0.DamageValues.Body')
  $cargoDamage = Get-Prop $raw @('JobValues.CargoValues.CargoDamage','GamePlay.JobDelivered.CargoDamage')
  $engineOn = Get-Prop $raw @('TruckValues.CurrentValues.EngineEnabled')
  $posX = Get-Prop $raw @('TruckValues.CurrentValues.PositionValue.X')
  $posZ = Get-Prop $raw @('TruckValues.CurrentValues.PositionValue.Z')
  $rpm = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.RPM')
  $speedLimit = Get-Prop $raw @('NavigationValues.SpeedLimit.Mph')
  $refuelAmount = Get-Prop $raw @('GamePlay.RefuelEvent.Amount')
  $fineAmount = Get-Prop $raw @('GamePlay.FinedEvent.Amount')
  $fineOffence = Get-Prop $raw @('GamePlay.FinedEvent.Offence')

  $data = [ordered]@{
    game = (Get-Prop $raw @('Game'))
    paused = As-Bool (Get-Prop $raw @('Paused'))
    sdkActive = As-Bool (Get-Prop $raw @('SdkActive'))
    speedMps = $speedMps
    speedLimitMph = As-Double $speedLimit
    truck = ((@($truckMake,$truckModel) | Where-Object { $_ }) -join ' ').Trim()
    cargo = $cargo
    sourceCity = $src
    destinationCity = $dst
    distanceKm = As-Double $distanceKm
    revenue = As-Double $revenue
    fuelLiters = As-Double $fuel
    refuelAmount = As-Double $refuelAmount
    odometerKm = As-Double $odometer
    truckDamage = As-Double $truckDamage
    trailerDamage = As-Double $trailerDamage
    cargoDamage = As-Double $cargoDamage
    engineOn = As-Bool $engineOn
    engineRpm = As-Double $rpm
    latitude = if ($null -ne $posX) { [double]$posX } else { $null }
    longitude = if ($null -ne $posZ) { [double]$posZ } else { $null }
    onJob = As-Bool (Get-Prop $raw @('SpecialEventsValues.OnJob'))
    fineAmount = As-Double $fineAmount
    fineOffence = if ($null -ne $fineOffence) { "$fineOffence" } else { $null }
  }

  $body = @{
    sessionCode = $SessionCode
    status = 'online'
    eventType = $eventType
    directEvent = [bool]$direct
    data = $data
  } | ConvertTo-Json -Depth 12

  Invoke-RestMethod -Method Post -Uri $PostUrl -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 8 | Out-Null
}

Write-Host 'Sterling Logistics Live Tracker'
Write-Host "Telemetry source: $TelemetryUrl"
Write-Host "Sterling API: $PostUrl"
Write-Host 'Tracking hours, miles, jobs, fuel, damage, fines, tolls and live status.'
Write-Host ''

$lastOnJob = $false
$lastFlags = @{}
foreach($n in @('JobDelivered','JobCancelled','Refuel','RefuelPayed','Fined','Tollgate','Ferry','Train')) { $lastFlags[$n]=$false }

while ($true) {
  try {
    $raw = Invoke-RestMethod -Method Get -Uri $TelemetryUrl -TimeoutSec 3
    if (-not (As-Bool (Get-Prop $raw @('SdkActive')))) {
      Write-Host ("[{0}] ETS2 SDK is not active yet" -f (Get-Date -Format 'HH:mm:ss'))
      Start-Sleep -Seconds 5
      continue
    }

    $onJob = As-Bool (Get-Prop $raw @('SpecialEventsValues.OnJob'))
    $event = 'heartbeat'
    $direct = $false

    $eventMap = [ordered]@{
      JobDelivered = 'job-delivered'
      JobCancelled = 'job-cancelled'
      Refuel = 'refuel'
      RefuelPayed = 'refuel-paid'
      Fined = 'fine'
      Tollgate = 'toll'
      Ferry = 'ferry'
      Train = 'train'
    }

    foreach($key in $eventMap.Keys) {
      $now = As-Bool (Get-Prop $raw @("SpecialEventsValues.$key"))
      if ($now -and -not $lastFlags[$key]) { $event=$eventMap[$key]; $direct=$true; break }
    }

    if (-not $direct) {
      if ($onJob -and -not $lastOnJob) { $event='job-started'; $direct=$true }
      elseif (-not $onJob -and $lastOnJob) { $event='job-ended'; $direct=$true }
    }

    Send-Telemetry $event $raw $direct
    $lastOnJob = $onJob
    foreach($key in $eventMap.Keys) { $lastFlags[$key] = As-Bool (Get-Prop $raw @("SpecialEventsValues.$key")) }
    Write-Host ("[{0}] sent {1}" -f (Get-Date -Format 'HH:mm:ss'),$event)
  } catch {
    Write-Host ("[{0}] tracker waiting: {1}" -f (Get-Date -Format 'HH:mm:ss'),$_.Exception.Message)
  }
  Start-Sleep -Seconds 10
}
