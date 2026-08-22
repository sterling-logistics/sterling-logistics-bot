using SCSSdkClient;
using SCSSdkClient.Object;
using System.Reflection;

namespace SterlingTracker;

internal sealed class TelemetryService : IDisposable
{
    private SCSSdkTelemetry? _telemetry;
    private readonly object _gate = new();
    private TelemetrySnapshot _latest = new();
    private bool _onJob, _delivered, _cancelled, _fined, _toll, _ferry, _train;

    public TelemetrySnapshot Latest { get { lock (_gate) return _latest; } }
    public bool Connected => _telemetry is { Error: null } && Latest.SdkActive;

    public event Action<TelemetrySnapshot>? SnapshotChanged;
    public event Action<string, TelemetrySnapshot>? TrackerEvent;
    public event Action<string>? StatusChanged;

    public void Start()
    {
        if (_telemetry is { Error: not null })
        {
            _telemetry.Dispose();
            _telemetry = null;
        }
        if (_telemetry is not null) return;
        try
        {
            _telemetry = new SCSSdkTelemetry(200);
            if (_telemetry.Error is not null)
            {
                StatusChanged?.Invoke("Waiting for ETS2 telemetry shared memory");
                return;
            }
            _telemetry.Data += OnData;
            StatusChanged?.Invoke("Telemetry client connected; start ETS2");
        }
        catch (Exception ex)
        {
            StatusChanged?.Invoke("Telemetry unavailable: " + ex.Message);
        }
    }

    private void OnData(SCSTelemetry data, bool changed)
    {
        if (!changed) return;
        var truck = data.TruckValues;
        var current = truck.CurrentValues;
        var dash = current.DashboardValues;
        var job = data.JobValues;
        var delivered = data.GamePlay?.JobDelivered;
        var trailerDamage = ReadNumber(data, "TrailerValues.0.DamageValues.Wear", "TrailerValues.0.DamageValues.Chassis", "TrailerValues.0.Damage");
        var truckDamage = Max(
            ReadNumber(current, "DamageValues.Engine"),
            ReadNumber(current, "DamageValues.Transmission"),
            ReadNumber(current, "DamageValues.Cabin"),
            ReadNumber(current, "DamageValues.Chassis"),
            ReadNumber(current, "DamageValues.Wheels"));
        var snapshot = new TelemetrySnapshot
        {
            SdkActive = data.SdkActive,
            Paused = data.Paused,
            Game = data.Game.ToString(),
            Truck = string.Join(" ", new[] { truck.ConstantsValues.Brand, truck.ConstantsValues.Name }.Where(x => !string.IsNullOrWhiteSpace(x))),
            SpeedMps = Math.Abs(dash.Speed.Value),
            EngineRpm = dash.RPM,
            EngineOn = current.EngineEnabled,
            FuelLiters = dash.FuelValue.Amount,
            FuelCapacityLiters = truck.ConstantsValues.CapacityValues.Fuel,
            OdometerKm = dash.Odometer,
            Cargo = job.CargoValues.Name ?? "",
            SourceCity = job.CitySource ?? "",
            DestinationCity = job.CityDestination ?? "",
            PlannedDistanceKm = job.PlannedDistanceKm,
            Revenue = job.Income,
            TruckDamage = truckDamage,
            TrailerDamage = trailerDamage,
            CargoDamage = job.CargoValues.CargoDamage,
            JobDeliveredDistanceKm = delivered?.DistanceKm ?? 0,
            JobDeliveredRevenue = delivered?.Revenue ?? 0,
            OnJob = data.SpecialEventsValues.OnJob
        };
        lock (_gate) _latest = snapshot;
        SnapshotChanged?.Invoke(snapshot);
        StatusChanged?.Invoke(snapshot.SdkActive ? (snapshot.Paused ? "ETS2 connected • paused" : "ETS2 connected • live") : "ETS2 telemetry inactive");

        var s = data.SpecialEventsValues;
        Rising(s.OnJob, ref _onJob, "job-started", snapshot);
        Rising(s.JobDelivered, ref _delivered, "job-delivered", snapshot);
        Rising(s.JobCancelled, ref _cancelled, "job-cancelled", snapshot);
        Rising(s.Fined, ref _fined, "fine", snapshot);
        Rising(s.Tollgate, ref _toll, "toll", snapshot);
        Rising(s.Ferry, ref _ferry, "ferry", snapshot);
        Rising(s.Train, ref _train, "train", snapshot);
    }

    private void Rising(bool value, ref bool previous, string eventType, TelemetrySnapshot snapshot)
    {
        if (value && !previous) TrackerEvent?.Invoke(eventType, snapshot);
        previous = value;
    }

    private static double Max(params double[] values) => values.Length == 0 ? 0 : values.Max();

    private static double ReadNumber(object? root, params string[] paths)
    {
        foreach (var path in paths)
        {
            object? current = root;
            foreach (var part in path.Split('.'))
            {
                if (current is null) break;
                if (int.TryParse(part, out var index) && current is System.Collections.IList list)
                {
                    current = index >= 0 && index < list.Count ? list[index] : null;
                    continue;
                }
                var t = current.GetType();
                var p = t.GetProperty(part, BindingFlags.Instance | BindingFlags.Public | BindingFlags.IgnoreCase);
                if (p is not null) { current = p.GetValue(current); continue; }
                var f = t.GetField(part, BindingFlags.Instance | BindingFlags.Public | BindingFlags.IgnoreCase);
                current = f?.GetValue(current);
            }
            if (current is null) continue;
            try { return Convert.ToDouble(current); } catch { }
        }
        return 0;
    }

    public void Dispose()
    {
        if (_telemetry is null) return;
        _telemetry.Dispose();
        _telemetry = null;
    }
}
