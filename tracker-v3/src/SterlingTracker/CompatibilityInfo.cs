using System.Diagnostics;

namespace SterlingTracker;

internal static class CompatibilityInfo
{
    public const string TrackerVersion = "3.1.0";
    public const string TruckersMpVersion = "0.7.4.x";
    public const string SupportedEts2Version = "1.60.x";
    public const string SupportedAtsVersion = "1.60.x";

    public static bool IsTruckersMpRunning()
    {
        try
        {
            return Process.GetProcesses().Any(p =>
            {
                try
                {
                    var n = p.ProcessName;
                    return n.Contains("TruckersMP", StringComparison.OrdinalIgnoreCase) ||
                           n.Contains("TruckersMP-Launcher", StringComparison.OrdinalIgnoreCase);
                }
                catch { return false; }
            });
        }
        catch { return false; }
    }

    public static string RuntimeSummary()
    {
        var tmp = IsTruckersMpRunning() ? "TruckersMP detected" : "TruckersMP not running";
        return $"Sterling Tracker {TrackerVersion} • {tmp} • ETS2 {SupportedEts2Version} • ATS {SupportedAtsVersion}";
    }
}
