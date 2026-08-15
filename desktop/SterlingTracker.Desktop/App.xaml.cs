using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows;

namespace SterlingTracker.Desktop;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        StartTelemetryBridge();
        base.OnStartup(e);
    }

    static void StartTelemetryBridge()
    {
        try
        {
            if (Process.GetProcessesByName("TelemetryJsonService").Any()) return;

            var exe = Path.Combine(AppContext.BaseDirectory, "Telemetry", "TelemetryJsonService.exe");
            if (!File.Exists(exe)) return;

            Process.Start(new ProcessStartInfo
            {
                FileName = exe,
                WorkingDirectory = Path.GetDirectoryName(exe)!,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        }
        catch
        {
            // MainWindow reports telemetry availability to the driver.
        }
    }
}
