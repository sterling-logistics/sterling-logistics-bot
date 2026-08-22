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
            var state = File.Exists(StatePath)
                ? JsonSerializer.Deserialize<TrackerState>(File.ReadAllText(StatePath), JsonOptions) ?? NewState()
                : NewState();

            // Tracker 3.0.3 is pinned to the dedicated Tracker API host.
            // Old saved values and old STERLING_TRACKER_API values must not
            // route the desktop app back to the Discord bot host.
            state.ApiBase = TrackerState.PrimaryApiBase;
            if (string.IsNullOrWhiteSpace(state.SessionCode)) state.SessionCode = $"trk3-{Guid.NewGuid():N}";
            Save(state);
            return state;
        }
        catch { return NewState(); }
    }

    public static void Save(TrackerState state)
    {
        Directory.CreateDirectory(Root);
        File.WriteAllText(StatePath, JsonSerializer.Serialize(state, JsonOptions));
    }

    private static TrackerState NewState()
    {
        var state = new TrackerState
        {
            ApiBase = TrackerState.PrimaryApiBase
        };
        Save(state);
        return state;
    }
}
