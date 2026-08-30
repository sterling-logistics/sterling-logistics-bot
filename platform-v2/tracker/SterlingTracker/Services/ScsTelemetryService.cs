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

    public ScsTelemetrySnapshot Latest
    {
        get { lock (_gate) return _latest; }
    }

    public bool Connected => _telemetry is { Error: null } && Latest.SdkActive;

    public void Start()
    {
        if (_telemetry is not null) return;
        var telemetry = new SCSSdkTelemetry(200);
        _telemetry = telemetry;
        if (telemetry.Error is not null)
        {
            lock (_gate) _latest = ScsTelemetrySnapshot.Empty with { Error = telemetry.Error.Message };
            return;
        }
        telemetry.Data += OnData;
    }

    private void OnData(SCSTelemetry data, bool changed)
    {
        if (!changed) return;

        var game = data.Game switch
        {
            SCSGame.Ats => "ats",
            SCSGame.Ets2 => "ets2",
            _ => null
        };

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
        var truckDamage = damage is null ? 0d : new[]
        {
            (double)damage.Engine,
            damage.Transmission,
            damage.Cabin,
            damage.Chassis,
            damage.WheelsAvg
        }.Max() * 100d;
        var cargoDamage = (double)(job?.CargoValues?.CargoDamage ?? 0f) * 100d;
        var damagePercent = Math.Clamp(Math.Max(truckDamage, cargoDamage), 0d, 100d);

        var heading = orientation is null ? (double?)null : NormalizeHeading(orientation.Heading * 360d);
        var snapshot = new ScsTelemetrySnapshot(
            SdkActive: data.SdkActive,
            Paused: data.Paused,
            Game: game,
            WorldX: pos?.X,
            WorldY: pos?.Y,
            WorldZ: pos?.Z,
            HeadingDeg: heading,
            SpeedKph: Math.Abs(dashboard?.Speed?.Kph ?? 0f),
            TruckMake: EmptyToNull(constants?.Brand),
            TruckModel: EmptyToNull(constants?.Name),
            FuelPercent: fuelPercent,
            DamagePercent: damagePercent,
            CargoDamagePercent: cargoDamage,
            Cargo: EmptyToNull(job?.CargoValues?.Name),
            OriginCity: EmptyToNull(job?.CitySource),
            DestinationCity: EmptyToNull(job?.CityDestination),
            OriginCompany: EmptyToNull(job?.CompanySource),
            DestinationCompany: EmptyToNull(job?.CompanyDestination),
            PlannedDistanceKm: job?.PlannedDistanceKm ?? 0,
            GameRevenue: job?.Income ?? 0,
            OnJob: special?.OnJob ?? false,
            FinesTotal: _finesTotal,
            DeliveredDistanceKm: gameplay?.JobDelivered?.DistanceKm ?? 0,
            DeliveredRevenue: gameplay?.JobDelivered?.Revenue ?? 0,
            DeliveredCargoDamagePercent: (gameplay?.JobDelivered?.CargoDamage ?? 0f) * 100d,
            Error: null);

        lock (_gate) _latest = snapshot;
        SnapshotChanged?.Invoke(this, snapshot);

        var onJob = special?.OnJob ?? false;
        var delivered = special?.JobDelivered ?? false;
        var cancelled = special?.JobCancelled ?? false;
        var fined = special?.Fined ?? false;

        if (onJob && !_previousOnJob)
            TelemetryEvent?.Invoke(this, new ScsTelemetryEvent(ScsTelemetryEventType.JobStarted, snapshot));

        if (delivered && !_previousDelivered)
            TelemetryEvent?.Invoke(this, new ScsTelemetryEvent(ScsTelemetryEventType.JobDelivered, snapshot));

        if (cancelled && !_previousCancelled)
            TelemetryEvent?.Invoke(this, new ScsTelemetryEvent(ScsTelemetryEventType.JobCancelled, snapshot));

        if (fined && !_previousFined)
        {
            var amount = Math.Max(0, gameplay?.FinedEvent?.Amount ?? 0);
            _finesTotal += amount;
            snapshot = snapshot with { FinesTotal = _finesTotal };
            lock (_gate) _latest = snapshot;
            TelemetryEvent?.Invoke(this, new ScsTelemetryEvent(ScsTelemetryEventType.Fine, snapshot, amount));
        }

        _previousOnJob = onJob;
        _previousDelivered = delivered;
        _previousCancelled = cancelled;
        _previousFined = fined;
    }

    private static double NormalizeHeading(double value)
    {
        value %= 360d;
        return value < 0 ? value + 360d : value;
    }

    private static string? EmptyToNull(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public void Dispose()
    {
        if (_telemetry is null) return;
        _telemetry.Data -= OnData;
        _telemetry.Dispose();
        _telemetry = null;
    }
}

public enum ScsTelemetryEventType
{
    JobStarted,
    JobDelivered,
    JobCancelled,
    Fine
}

public sealed record ScsTelemetryEvent(ScsTelemetryEventType Type, ScsTelemetrySnapshot Snapshot, long Amount = 0);

public sealed record ScsTelemetrySnapshot(
    bool SdkActive,
    bool Paused,
    string? Game,
    double? WorldX,
    double? WorldY,
    double? WorldZ,
    double? HeadingDeg,
    double SpeedKph,
    string? TruckMake,
    string? TruckModel,
    double? FuelPercent,
    double DamagePercent,
    double CargoDamagePercent,
    string? Cargo,
    string? OriginCity,
    string? DestinationCity,
    string? OriginCompany,
    string? DestinationCompany,
    uint PlannedDistanceKm,
    ulong GameRevenue,
    bool OnJob,
    double FinesTotal,
    float DeliveredDistanceKm,
    long DeliveredRevenue,
    double DeliveredCargoDamagePercent,
    string? Error)
{
    public static ScsTelemetrySnapshot Empty { get; } = new(
        false, false, null, null, null, null, null, 0, null, null, null, 0, 0,
        null, null, null, null, null, 0, 0, false, 0, 0, 0, 0, null);
}
