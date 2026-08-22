namespace SterlingTracker;

internal sealed class TelemetrySnapshot
{
    public bool SdkActive { get; init; }
    public bool Paused { get; init; }
    public string Game { get; init; } = "ETS2";
    public string Truck { get; init; } = "";
    public double SpeedMps { get; init; }
    public double EngineRpm { get; init; }
    public bool EngineOn { get; init; }
    public double FuelLiters { get; init; }
    public double FuelCapacityLiters { get; init; }
    public double OdometerKm { get; init; }
    public string Cargo { get; init; } = "";
    public string SourceCity { get; init; } = "";
    public string DestinationCity { get; init; } = "";
    public double PlannedDistanceKm { get; init; }
    public double Revenue { get; init; }
    public double TruckDamage { get; init; }
    public double TrailerDamage { get; init; }
    public double CargoDamage { get; init; }
    public double Latitude { get; init; }
    public double Longitude { get; init; }
    public double JobDeliveredDistanceKm { get; init; }
    public double JobDeliveredRevenue { get; init; }
    public bool OnJob { get; init; }

    public Dictionary<string, object?> ToApiData() => new()
    {
        ["game"] = Game,
        ["truck"] = Truck,
        ["speedMps"] = SpeedMps,
        ["engineRpm"] = EngineRpm,
        ["engineOn"] = EngineOn,
        ["fuelLiters"] = FuelLiters,
        ["fuelCapacityLiters"] = FuelCapacityLiters,
        ["odometerKm"] = OdometerKm,
        ["cargo"] = Cargo,
        ["sourceCity"] = SourceCity,
        ["destinationCity"] = DestinationCity,
        ["distanceKm"] = PlannedDistanceKm,
        ["revenue"] = Revenue,
        ["truckDamage"] = TruckDamage,
        ["trailerDamage"] = TrailerDamage,
        ["cargoDamage"] = CargoDamage,
        ["latitude"] = Latitude,
        ["longitude"] = Longitude,
        ["jobDeliveredDistanceKm"] = JobDeliveredDistanceKm,
        ["jobDeliveredRevenue"] = JobDeliveredRevenue
    };
}

internal sealed class DriverProfile
{
    public string SterlingDriverId { get; init; } = "";
    public string DiscordUsername { get; init; } = "";
    public string? Rank { get; init; }
    public double TotalMiles { get; init; }
    public int JobsCompleted { get; init; }
}

internal sealed class TrackerState
{
    public const string PrimaryApiBase = "https://sterlinglogisticsvtc.co.uk";
    public const string LegacyApiBase = "http://45.43.163.175:3000";
    public string ApiBase { get; set; } = PrimaryApiBase;
    public string SessionCode { get; set; } = $"trk3-{Guid.NewGuid():N}";
    public string? AccessToken { get; set; }
}
