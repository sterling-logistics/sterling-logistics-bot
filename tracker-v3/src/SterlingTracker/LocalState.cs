using System.Text.Json;

namespace SterlingTracker;

internal static class LocalState
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sterling Logistics", "Tracker");
    private static readonly string StatePath = Path.Combine(Root, "tracker-state.json");

    public static TrackerState Load()
    {
        Directory.CreateDirectory(Root);
        try
        {
            if (!File.Exists(StatePath)) return NewState();
            var state = JsonSerializer.Deserialize<TrackerState>(File.ReadAllText(StatePath), JsonOptions) ?? NewState();
            var envApi = Environment.GetEnvironmentVariable("STERLING_TRACKER_API");
            if (!string.IsNullOrWhiteSpace(envApi))
            {
                state.ApiBase = envApi.TrimEnd('/');
            }
            else if (string.IsNullOrWhiteSpace(state.ApiBase) || IsLegacyApi(state.ApiBase))
            {
                state.ApiBase = TrackerState.PrimaryApiBase;
                Save(state);
            }
            if (string.IsNullOrWhiteSpace(state.SessionCode)) state.SessionCode = $"trk3-{Guid.NewGuid():N}";
            return state;
        }
        catch { return NewState(); }
    }

    private static bool IsLegacyApi(string value)
    {
        var api = value.TrimEnd('/');
        return string.Equals(api, TrackerState.LegacyApiBase, StringComparison.OrdinalIgnoreCase)
            || string.Equals(api, TrackerState.LegacyApiBase8101, StringComparison.OrdinalIgnoreCase)
            || string.Equals(api, TrackerState.LegacyWebsiteApiBase, StringComparison.OrdinalIgnoreCase);
    }

    public static void Save(TrackerState state)
    {
        Directory.CreateDirectory(Root);
        File.WriteAllText(StatePath, JsonSerializer.Serialize(state, JsonOptions));
    }

    private static TrackerState NewState()
    {
        var state = new TrackerState();
        var envApi = Environment.GetEnvironmentVariable("STERLING_TRACKER_API");
        if (!string.IsNullOrWhiteSpace(envApi)) state.ApiBase = envApi.TrimEnd('/');
        Save(state);
        return state;
    }
}
