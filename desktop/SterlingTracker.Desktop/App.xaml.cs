using System.Windows;

namespace SterlingTracker.Desktop;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // Tracker 2.0 reads ETS2 telemetry directly from the RenCloud
        // Local\SCSTelemetry memory-mapped file. No localhost JSON service
        // is started or required anymore.
        base.OnStartup(e);
    }
}
