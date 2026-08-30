using System.Diagnostics;

namespace Sterling.Logistics.Tracker.Services;

public sealed record GameDetection(string? Game, bool IsRunning);

public sealed class GameDetector
{
    public GameDetection Detect()
    {
        if (Process.GetProcessesByName("eurotrucks2").Length > 0)
            return new GameDetection("ets2", true);
        if (Process.GetProcessesByName("amtrucks").Length > 0)
            return new GameDetection("ats", true);
        return new GameDetection(null, false);
    }
}
