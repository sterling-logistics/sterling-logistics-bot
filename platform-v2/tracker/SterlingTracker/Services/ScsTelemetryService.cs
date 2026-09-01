using SCSSdkClient;
using SCSSdkClient.Object;

namespace Sterling.Logistics.Tracker.Services;

public sealed class ScsTelemetryService : IDisposable
{
    private readonly object _gate = new();
    private SCSSdkTelemetry? _telemetry;
    private ScsTelemetrySnapshot _latest = ScsTelemetrySnapshot.Empty;
    private bool _previousOnJob;
    private bool _previousDelivered;
    private bool _previousCancelled;
    private bool _previousFined;
    private double _finesTotal;

    public event EventHandler<ScsTelemetrySnapshot>? SnapshotChanged;
    public event EventHandler<ScsTelemetryEvent>? TelemetryEvent;

    public ScsTelemetrySnapshot Latest { get { lock (_gate) return _latest; } }
    public bool Connected => _telemetry is { Error: null } && Latest.SdkActive;

    public void Start()
    {
        if (_telemetry is not null) return;
        try
        {
            var telemetry = new SCSSdkTelemetry(200);
            _telemetry = telemetry;
            if (telemetry.Error is not null)
            {
                SetError(telemetry.Error.Message);
                return;
            }
            telemetry.Data += OnData;
        }
        catch (Exception ex)
        {
            SetError($"Telemetry unavailable: {ex.Message}");
        }
    }

    private void OnData(SCSTelemetry data, bool changed)
    {
        if (!changed) return;
        try { ProcessData(data); }
        catch (Exception ex) { SetError($"Telemetry read error: {ex.Message}"); }
    }

    private void ProcessData(SCSTelemetry data)
    {
        var game = data.Game switch { SCSGame.Ats => "ats", SCSGame.Ets2 => "ets2", _ => null };
        var truck = data.TruckValues;
        var constants = truck?.ConstantsValues;
        var current = truck?.CurrentValues;
        var dashboard = current?.DashboardValues;
        var job = data.JobValues;
        var position = current?.PositionValue;
        var pos = position?.Position;
        var orientation = position?.Orientation;
        var special = data.SpecialEventsValues;
        var gameplay = data.GamePlay;

        var fuelCapacity = constants?.CapacityValues?.Fuel ?? 0f;
        var fuelAmount = dashboard?.FuelValue?.Amount ?? 0f;
        var fuelPercent = fuelCapacity > 0 ? Math.Clamp(fuelAmount / fuelCapacity * 100d, 0d, 100d) : (double?)null;
        var damage = current?.DamageValues;
        var truckDamage = damage is null ? 0d : new[] { (double)damage.Engine, damage.Transmission, damage.Cabin, damage.Chassis, damage.WheelsAvg }.Max() * 100d;
        var cargoDamage = (double)(job?.CargoValues?.CargoDamage ?? 0f) * 100d;
        var damagePercent = Math.Clamp(Math.Max(truckDamage, cargoDamage), 0d, 100d);
        var heading = orientation is null ? (double?)null : NormalizeHeading(orientation.Heading * 360d);

        var deliveredDistance = gameplay?.JobDelivered?.DistanceKm ?? 0;
        var deliveredRevenue = gameplay?.JobDelivered?.Revenue ?? 0;
        var deliveredCargoDamage = (gameplay?.JobDelivered?.CargoDamage ?? 0f) * 100d;

        var snapshot = new ScsTelemetrySnapshot(data.SdkActive, data.Paused, game, pos?.X, pos?.Y, pos?.Z, heading,
            Math.Abs(dashboard?.Speed?.Kph ?? 0f), EmptyToNull(constants?.Brand), EmptyToNull(constants?.Name), fuelPercent,
            damagePercent, cargoDamage, EmptyToNull(job?.CargoValues?.Name), EmptyToNull(job?.CitySource), EmptyToNull(job?.CityDestination),
            EmptyToNull(job?.CompanySource), EmptyToNull(job?.CompanyDestination), job?.PlannedDistanceKm ?? 0, job?.Income ?? 0,
            special?.OnJob ?? false, _finesTotal, deliveredDistance, deliveredRevenue, deliveredCargoDamage, null);

        lock (_gate) _latest = snapshot;
        SafeSnapshotChanged(snapshot);

        var onJob = special?.OnJob ?? false;
        var cancelled = special?.JobCancelled ?? false;
        var explicitDelivered = special?.JobDelivered ?? false;
        var hasDeliveryPayload = deliveredDistance > 0 || deliveredRevenue > 0;
        var endedJobWithDeliveryPayload = _previousOnJob && !onJob && hasDeliveryPayload && !cancelled;
        var delivered = explicitDelivered || endedJobWithDeliveryPayload;
        var fined = special?.Fined ?? false;

        if (onJob && !_previousOnJob) SafeTelemetryEvent(new ScsTelemetryEvent(ScsTelemetryEventType.JobStarted, snapshot));
        if (delivered && !_previousDelivered) SafeTelemetryEvent(new ScsTelemetryEvent(ScsTelemetryEventType.JobDelivered, snapshot));
        if (cancelled && !_previousCancelled) SafeTelemetryEvent(new ScsTelemetryEvent(ScsTelemetryEventType.JobCancelled, snapshot));
        if (fined && !_previousFined)
        {
            var amount = Math.Max(0, gameplay?.FinedEvent?.Amount ?? 0);
            _finesTotal += amount;
            snapshot = snapshot with { FinesTotal = _finesTotal };
            lock (_gate) _latest = snapshot;
            SafeTelemetryEvent(new ScsTelemetryEvent(ScsTelemetryEventType.Fine, snapshot, amount));
        }

        _previousOnJob = onJob;
        _previousDelivered = delivered;
        _previousCancelled = cancelled;
        _previousFined = fined;
    }

    private void SetError(string message)
    {
        ScsTelemetrySnapshot snapshot;
        lock (_gate) { _latest = _latest with { Error = message, SdkActive = false }; snapshot = _latest; }
        SafeSnapshotChanged(snapshot);
    }

    private void SafeSnapshotChanged(ScsTelemetrySnapshot snapshot)
    {
        try { SnapshotChanged?.Invoke(this, snapshot); } catch { }
    }
    private void SafeTelemetryEvent(ScsTelemetryEvent evt)
    {
        try { TelemetryEvent?.Invoke(this, evt); } catch { }
    }
    private static double NormalizeHeading(double value) { value %= 360d; return value < 0 ? value + 360d : value; }
    private static string? EmptyToNull(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public void Dispose()
    {
        var telemetry = _telemetry;
        _telemetry = null;
        if (telemetry is null) return;
        try { telemetry.Data -= OnData; } catch { }
        try { telemetry.Dispose(); } catch { }
    }
}

public enum ScsTelemetryEventType { JobStarted, JobDelivered, JobCancelled, Fine }
public sealed record ScsTelemetryEvent(ScsTelemetryEventType Type, ScsTelemetrySnapshot Snapshot, long Amount = 0);
public sealed record ScsTelemetrySnapshot(bool SdkActive, bool Paused, string? Game, double? WorldX, double? WorldY, double? WorldZ,
    double? HeadingDeg, double SpeedKph, string? TruckMake, string? TruckModel, double? FuelPercent, double DamagePercent,
    double CargoDamagePercent, string? Cargo, string? OriginCity, string? DestinationCity, string? OriginCompany,
    string? DestinationCompany, uint PlannedDistanceKm, ulong GameRevenue, bool OnJob, double FinesTotal, float DeliveredDistanceKm,
    long DeliveredRevenue, double DeliveredCargoDamagePercent, string? Error)
{
    public static ScsTelemetrySnapshot Empty { get; } = new(false, false, null, null, null, null, null, 0, null, null, null, 0, 0,
        null, null, null, null, null, 0, 0, false, 0, 0, 0, 0, null);
}
