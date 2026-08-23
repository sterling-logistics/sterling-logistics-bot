using SCSSdkClient;
using SCSSdkClient.Object;
using System.Reflection;

namespace SterlingTracker;

internal sealed class TelemetryService : IDisposable
{
    private SCSSdkTelemetry? _telemetry;
    private readonly object _gate = new();
    private TelemetrySnapshot _latest = new();
    private TelemetrySnapshot? _activeJob;
    private bool _onJob, _delivered, _cancelled, _fined, _toll, _ferry, _train;

    public TelemetrySnapshot Latest { get { lock (_gate) return _latest; } }
    public bool Connected => _telemetry is { Error: null } && Latest.SdkActive;
    public event Action<TelemetrySnapshot>? SnapshotChanged;
    public event Action<string, TelemetrySnapshot>? TrackerEvent;
    public event Action<string>? StatusChanged;

    public void Start()
    {
        if (_telemetry is { Error: not null }) { _telemetry.Dispose(); _telemetry = null; }
        if (_telemetry is not null) return;
        try { _telemetry = new SCSSdkTelemetry(200); if (_telemetry.Error is not null) { StatusChanged?.Invoke("Waiting for ETS2 telemetry shared memory"); return; } _telemetry.Data += OnData; StatusChanged?.Invoke("Telemetry client connected; start ETS2 / ATS"); }
        catch (Exception ex) { StatusChanged?.Invoke("Telemetry unavailable: " + ex.Message); }
    }

    private void OnData(SCSTelemetry data, bool changed)
    {
        if (!changed) return;
        var truck=data.TruckValues; var current=truck.CurrentValues; var dash=current.DashboardValues; var job=data.JobValues; var delivered=data.GamePlay?.JobDelivered; var s=data.SpecialEventsValues;
        var trailerDamage=ReadNumber(data,"TrailerValues.0.DamageValues.Wear","TrailerValues.0.DamageValues.Chassis","TrailerValues.0.Damage");
        var truckDamage=Max(ReadNumber(current,"DamageValues.Engine"),ReadNumber(current,"DamageValues.Transmission"),ReadNumber(current,"DamageValues.Cabin"),ReadNumber(current,"DamageValues.Chassis"),ReadNumber(current,"DamageValues.Wheels"));
        var snapshot=new TelemetrySnapshot {
            SdkActive=data.SdkActive,Paused=data.Paused,Game=data.Game.ToString(),Truck=string.Join(" ",new[]{truck.ConstantsValues.Brand,truck.ConstantsValues.Name}.Where(x=>!string.IsNullOrWhiteSpace(x))),
            SpeedMps=Math.Abs(dash.Speed.Value),EngineRpm=dash.RPM,EngineOn=current.EngineEnabled,FuelLiters=dash.FuelValue.Amount,FuelCapacityLiters=truck.ConstantsValues.CapacityValues.Fuel,OdometerKm=dash.Odometer,
            Cargo=job.CargoValues.Name??"",SourceCity=job.CitySource??"",DestinationCity=job.CityDestination??"",PlannedDistanceKm=job.PlannedDistanceKm,Revenue=job.Income,
            TruckDamage=truckDamage,TrailerDamage=trailerDamage,CargoDamage=job.CargoValues.CargoDamage,JobDeliveredDistanceKm=delivered?.DistanceKm??0,JobDeliveredRevenue=delivered?.Revenue??0,OnJob=s.OnJob };

        // Keep the last populated job snapshot because ETS2/ATS clears JobValues around delivery.
        if (snapshot.OnJob && HasJobMetadata(snapshot)) _activeJob=snapshot;

        // Some game/TMP combinations briefly miss the JobDelivered special-event rising edge.
        // If OnJob falls and the SDK delivery payload already contains distance/revenue, treat
        // that as a completed job instead of leaving it stuck "in progress" forever.
        var fallbackDelivered = _onJob && !s.OnJob && !s.JobDelivered && !s.JobCancelled && _activeJob is not null &&
            ((delivered?.DistanceKm ?? 0) > 0 || (delivered?.Revenue ?? 0) > 0);

        if ((s.JobDelivered || fallbackDelivered) && _activeJob is not null) snapshot=MergeJob(snapshot,_activeJob);

        lock(_gate)_latest=snapshot; SnapshotChanged?.Invoke(snapshot);
        var gameName = snapshot.Game.Contains("American",StringComparison.OrdinalIgnoreCase) || snapshot.Game.Contains("ATS",StringComparison.OrdinalIgnoreCase) ? "ATS" : "ETS2";
        StatusChanged?.Invoke(snapshot.SdkActive?(snapshot.Paused?$"{gameName} connected • paused":$"{gameName} connected • live"):$"{gameName} telemetry inactive");

        Rising(s.OnJob,ref _onJob,"job-started",snapshot);
        Rising(s.JobDelivered,ref _delivered,"job-delivered",snapshot);
        if (fallbackDelivered && !s.JobDelivered) TrackerEvent?.Invoke("job-delivered",snapshot);
        Rising(s.JobCancelled,ref _cancelled,"job-cancelled",snapshot);
        Rising(s.Fined,ref _fined,"fine",snapshot); Rising(s.Tollgate,ref _toll,"toll",snapshot); Rising(s.Ferry,ref _ferry,"ferry",snapshot); Rising(s.Train,ref _train,"train",snapshot);
        if(!s.OnJob&&!s.JobDelivered&&!fallbackDelivered&&_activeJob is not null)_activeJob=null;
        if(s.JobDelivered||fallbackDelivered||s.JobCancelled)_activeJob=null;
    }

    private void Rising(bool value,ref bool previous,string eventType,TelemetrySnapshot snapshot){if(value&&!previous)TrackerEvent?.Invoke(eventType,snapshot);previous=value;}
    private static bool HasJobMetadata(TelemetrySnapshot s)=>!string.IsNullOrWhiteSpace(s.Cargo)||!string.IsNullOrWhiteSpace(s.SourceCity)||!string.IsNullOrWhiteSpace(s.DestinationCity);
    private static string Pick(string a,string b)=>string.IsNullOrWhiteSpace(a)?b:a;
    private static TelemetrySnapshot MergeJob(TelemetrySnapshot c,TelemetrySnapshot s)=>new(){SdkActive=c.SdkActive,Paused=c.Paused,Game=c.Game,Truck=c.Truck,SpeedMps=c.SpeedMps,EngineRpm=c.EngineRpm,EngineOn=c.EngineOn,FuelLiters=c.FuelLiters,FuelCapacityLiters=c.FuelCapacityLiters,OdometerKm=c.OdometerKm,Cargo=Pick(c.Cargo,s.Cargo),SourceCity=Pick(c.SourceCity,s.SourceCity),DestinationCity=Pick(c.DestinationCity,s.DestinationCity),PlannedDistanceKm=c.PlannedDistanceKm>0?c.PlannedDistanceKm:s.PlannedDistanceKm,Revenue=c.Revenue>0?c.Revenue:s.Revenue,TruckDamage=c.TruckDamage,TrailerDamage=c.TrailerDamage,CargoDamage=c.CargoDamage,Latitude=c.Latitude,Longitude=c.Longitude,JobDeliveredDistanceKm=c.JobDeliveredDistanceKm,JobDeliveredRevenue=c.JobDeliveredRevenue,OnJob=c.OnJob};
    private static double Max(params double[] values)=>values.Length==0?0:values.Max();
    private static double ReadNumber(object? root,params string[] paths){foreach(var path in paths){object? cur=root;foreach(var part in path.Split('.')){if(cur is null)break;if(int.TryParse(part,out var i)&&cur is System.Collections.IList list){cur=i>=0&&i<list.Count?list[i]:null;continue;}var t=cur.GetType();var p=t.GetProperty(part,BindingFlags.Instance|BindingFlags.Public|BindingFlags.IgnoreCase);if(p is not null){cur=p.GetValue(cur);continue;}var f=t.GetField(part,BindingFlags.Instance|BindingFlags.Public|BindingFlags.IgnoreCase);cur=f?.GetValue(cur);}if(cur is null)continue;try{return Convert.ToDouble(cur);}catch{}}return 0;}
    public void Dispose(){if(_telemetry is null)return;_telemetry.Dispose();_telemetry=null;}
}
