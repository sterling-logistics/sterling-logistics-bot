param(
  [Parameter(Mandatory=$true)][string]$ApiBase,
  [Parameter(Mandatory=$true)][string]$TrackerKey
)

$ErrorActionPreference = 'Stop'
$TelemetryUrl = 'http://localhost:6969/'
$PostUrl = ($ApiBase.TrimEnd('/')) + '/api/tracker/telemetry'
$PayoutUrl = ($ApiBase.TrimEnd('/')) + '/api/tracker/payout'
$SessionCode = 'win-' + [guid]::NewGuid().ToString('N')
$headers = @{ Authorization = "Bearer $TrackerKey" }
$lastPayoutCheck = [datetime]::MinValue

function Get-Prop($obj, [string[]]$paths) {
  foreach ($path in $paths) {
    $cur = $obj; $ok = $true
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
function As-Double($v) { if ($null -eq $v) { return 0.0 }; try { return [double]$v } catch { return 0.0 } }
function As-Bool($v) { if ($null -eq $v) { return $false }; try { return [bool]$v } catch { return $false } }
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

function Get-NewestLocalEts2Save {
  $root = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Euro Truck Simulator 2'
  $profiles = Join-Path $root 'profiles'
  if (-not (Test-Path $profiles)) { throw "Local ETS2 profiles folder was not found at $profiles. Steam Cloud profiles are not automatically edited." }
  $files = Get-ChildItem -Path $profiles -Filter 'game.sii' -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  if (-not $files -or $files.Count -eq 0) { throw 'No local ETS2 game.sii save file was found.' }
  return $files[0]
}

function Add-MoneyToTextSave([string]$savePath,[decimal]$amount) {
  $lines = [System.IO.File]::ReadAllLines($savePath)
  if ($lines.Count -eq 0 -or -not (($lines -join "`n") -match 'money_account\s*:')) {
    throw 'This save is not readable as a text save. Set g_save_format to 2, save the game again, close ETS2, then retry.'
  }

  $stack = New-Object System.Collections.Generic.List[string]
  $bankIndex = -1; $economyIndex = -1
  for ($i=0; $i -lt $lines.Count; $i++) {
    $t = $lines[$i].Trim()
    if ($t -match '^([A-Za-z0-9_]+)\s*:\s*\S+\s*\{$') { $stack.Add($Matches[1]); continue }
    if ($t -eq '}') { if ($stack.Count -gt 0) { $stack.RemoveAt($stack.Count-1) }; continue }
    if ($t -match '^money_account\s*:\s*(-?\d+)\s*$') {
      $current = if ($stack.Count -gt 0) { $stack[$stack.Count-1] } else { '' }
      if ($current -eq 'bank' -and $bankIndex -lt 0) { $bankIndex=$i }
      elseif ($current -eq 'economy' -and $economyIndex -lt 0) { $economyIndex=$i }
    }
  }
  $idx = if ($bankIndex -ge 0) { $bankIndex } else { $economyIndex }
  if ($idx -lt 0) { throw 'Could not locate the player money_account in the ETS2 save.' }
  if ($lines[$idx] -notmatch '^(\s*)money_account\s*:\s*(-?\d+)\s*$') { throw 'Could not parse ETS2 money_account.' }
  $indent=$Matches[1]; $old=[int64]$Matches[2]; $add=[int64][math]::Truncate([double]$amount); $new=$old+$add
  if ($new -lt $old) { throw 'The resulting ETS2 balance would be invalid.' }
  $backup = "$savePath.sterling-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $savePath -Destination $backup -Force
  $lines[$idx] = "${indent}money_account: $new"
  [System.IO.File]::WriteAllLines($savePath,$lines,[System.Text.UTF8Encoding]::new($false))
  return @{ Old=$old; New=$new; Backup=$backup }
}

function Try-ApplyPendingPayout {
  if (((Get-Date) - $lastPayoutCheck).TotalSeconds -lt 15) { return }
  $script:lastPayoutCheck = Get-Date
  try {
    $response = Invoke-RestMethod -Method Get -Uri $PayoutUrl -Headers $headers -TimeoutSec 8
    $p = $response.payout
    if ($null -eq $p) { return }
    $amount = [decimal]$p.amount
    $id = [int64]$p.id
    if (Get-Process -Name 'eurotrucks2' -ErrorAction SilentlyContinue) {
      Write-Host ("[{0}] payout #{1} £{2:N2} waiting - close ETS2 to apply safely" -f (Get-Date -Format 'HH:mm:ss'),$id,$amount)
      return
    }
    $save = Get-NewestLocalEts2Save
    $result = Add-MoneyToTextSave $save.FullName $amount
    $body = @{ savePath=$save.FullName } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$PayoutUrl/$id/complete" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 8 | Out-Null
    Write-Host ("[{0}] ETS2 payout #{1} applied: £{2:N2}; game balance {3} -> {4}; backup {5}" -f (Get-Date -Format 'HH:mm:ss'),$id,$amount,$result.Old,$result.New,$result.Backup)
  } catch {
    $msg=$_.Exception.Message
    Write-Host ("[{0}] ETS2 payout waiting: {1}" -f (Get-Date -Format 'HH:mm:ss'),$msg)
    try {
      if ($null -ne $p -and $null -ne $p.id) {
        $failBody=@{error=$msg}|ConvertTo-Json
        Invoke-RestMethod -Method Post -Uri "$PayoutUrl/$($p.id)/fail" -Headers $headers -ContentType 'application/json' -Body $failBody -TimeoutSec 5 | Out-Null
      }
    } catch {}
  }
}

function Send-Telemetry($eventType, $raw, $direct=$false, $gameTimeJump=0) {
  $speed = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.Speed.Value','TruckValues.CurrentValues.DashboardValues.Speed.Kph')
  $speedIsKph = $null -eq (Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.Speed.Value'))
  $speedMps = As-Double $speed; if ($speedIsKph) { $speedMps = $speedMps / 3.6 }
  $truckMake = Get-Prop $raw @('TruckValues.ConstantsValues.Brand'); $truckModel = Get-Prop $raw @('TruckValues.ConstantsValues.Name','TruckValues.ConstantsValues.Model')
  $cargo = Get-Prop $raw @('JobValues.CargoValues.Name'); $src = Get-Prop $raw @('JobValues.CitySource'); $dst = Get-Prop $raw @('JobValues.CityDestination')
  $distanceKm = Get-Prop $raw @('GamePlay.JobDelivered.DistanceKm','JobValues.PlannedDistanceKm'); $revenue = Get-Prop $raw @('GamePlay.JobDelivered.Revenue','JobValues.Income')
  $fuel = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.FuelValue.Amount'); $odometer = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.Odometer')
  $truckDamage = Max-Damage $raw; $trailerDamage = Get-Prop $raw @('TrailerValues.0.DamageValues.Body'); $cargoDamage = Get-Prop $raw @('JobValues.CargoValues.CargoDamage','GamePlay.JobDelivered.CargoDamage')
  $engineOn = Get-Prop $raw @('TruckValues.CurrentValues.EngineEnabled'); $posX = Get-Prop $raw @('TruckValues.CurrentValues.PositionValue.X'); $posZ = Get-Prop $raw @('TruckValues.CurrentValues.PositionValue.Z')
  $rpm = Get-Prop $raw @('TruckValues.CurrentValues.DashboardValues.RPM'); $speedLimit = Get-Prop $raw @('NavigationValues.SpeedLimit.Mph'); $refuelAmount = Get-Prop $raw @('GamePlay.RefuelEvent.Amount')
  $fineAmount = Get-Prop $raw @('GamePlay.FinedEvent.Amount'); $fineOffence = Get-Prop $raw @('GamePlay.FinedEvent.Offence'); $gameTime = Get-Prop $raw @('CommonValues.GameTime.Value')
  $data = [ordered]@{game=(Get-Prop $raw @('Game'));paused=As-Bool (Get-Prop $raw @('Paused'));sdkActive=As-Bool (Get-Prop $raw @('SdkActive'));speedMps=$speedMps;speedLimitMph=As-Double $speedLimit;truck=((@($truckMake,$truckModel)|Where-Object{$_})-join ' ').Trim();cargo=$cargo;sourceCity=$src;destinationCity=$dst;distanceKm=As-Double $distanceKm;revenue=As-Double $revenue;fuelLiters=As-Double $fuel;refuelAmount=As-Double $refuelAmount;odometerKm=As-Double $odometer;truckDamage=As-Double $truckDamage;trailerDamage=As-Double $trailerDamage;cargoDamage=As-Double $cargoDamage;engineOn=As-Bool $engineOn;engineRpm=As-Double $rpm;gameTime=As-Double $gameTime;gameTimeJump=As-Double $gameTimeJump;latitude=if($null-ne$posX){[double]$posX}else{$null};longitude=if($null-ne$posZ){[double]$posZ}else{$null};onJob=As-Bool (Get-Prop $raw @('SpecialEventsValues.OnJob'));fineAmount=As-Double $fineAmount;fineOffence=if($null-ne$fineOffence){"$fineOffence"}else{$null}}
  $body=@{sessionCode=$SessionCode;status='online';eventType=$eventType;directEvent=[bool]$direct;data=$data}|ConvertTo-Json -Depth 12
  Invoke-RestMethod -Method Post -Uri $PostUrl -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 8 | Out-Null
}

Write-Host 'Sterling Logistics Live Tracker'
Write-Host "Telemetry source: $TelemetryUrl"
Write-Host "Sterling API: $PostUrl"
Write-Host 'Tracking hours, miles, jobs, fuel, damage, fines, tolls, rest stops and live status.'
Write-Host 'ETS2 wallet sync enabled: queued /withdraw payouts apply only while ETS2 is closed, with a save backup first.'
Write-Host ''

$lastOnJob=$false; $lastGameTime=$null; $lastFlags=@{}
foreach($n in @('JobDelivered','JobCancelled','Refuel','RefuelPayed','Fined','Tollgate','Ferry','Train')){$lastFlags[$n]=$false}

while($true){
  Try-ApplyPendingPayout
  try{
    $raw=Invoke-RestMethod -Method Get -Uri $TelemetryUrl -TimeoutSec 3
    if(-not(As-Bool(Get-Prop $raw @('SdkActive')))){Write-Host("[{0}] ETS2 SDK is not active yet" -f(Get-Date -Format 'HH:mm:ss'));Start-Sleep -Seconds 5;continue}
    $onJob=As-Bool(Get-Prop $raw @('SpecialEventsValues.OnJob'));$event='heartbeat';$direct=$false;$gameTime=As-Double(Get-Prop $raw @('CommonValues.GameTime.Value'));$gameTimeJump=0.0
    if($null-ne$lastGameTime-and$gameTime-gt0){$gameTimeJump=$gameTime-$lastGameTime;if($gameTimeJump-lt0){$gameTimeJump=0}}
    $eventMap=[ordered]@{JobDelivered='job-delivered';JobCancelled='job-cancelled';Refuel='refuel';RefuelPayed='refuel-paid';Fined='fine';Tollgate='toll';Ferry='ferry';Train='train'}
    foreach($key in $eventMap.Keys){$now=As-Bool(Get-Prop $raw @("SpecialEventsValues.$key"));if($now-and-not$lastFlags[$key]){$event=$eventMap[$key];$direct=$true;break}}
    if(-not$direct-and$gameTimeJump-ge120){$event='rest-stop';$direct=$true}
    if(-not$direct){if($onJob-and-not$lastOnJob){$event='job-started';$direct=$true}elseif(-not$onJob-and$lastOnJob){$event='job-ended';$direct=$true}}
    Send-Telemetry $event $raw $direct $gameTimeJump
    $lastOnJob=$onJob;if($gameTime-gt0){$lastGameTime=$gameTime};foreach($key in $eventMap.Keys){$lastFlags[$key]=As-Bool(Get-Prop $raw @("SpecialEventsValues.$key"))}
    Write-Host("[{0}] sent {1}" -f(Get-Date -Format 'HH:mm:ss'),$event)
  }catch{Write-Host("[{0}] tracker waiting: {1}" -f(Get-Date -Format 'HH:mm:ss'),$_.Exception.Message)}
  Start-Sleep -Seconds 10
}
