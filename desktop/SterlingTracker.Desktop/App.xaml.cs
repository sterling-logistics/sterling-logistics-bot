using System;
using System.Threading;
using System.Windows;

namespace SterlingTracker.Desktop;

public partial class App : Application
{
    Mutex? instanceMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        // Only one tracker process may run per Windows session. This prevents
        // duplicate telemetry uploads and duplicate Discord events when users
        // click the shortcut more than once or Windows startup races a manual launch.
        instanceMutex = new Mutex(true, @"Local\SterlingLogisticsTracker", out var firstInstance);
        if (!firstInstance)
        {
            Shutdown();
            return;
        }

        base.OnStartup(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try { instanceMutex?.ReleaseMutex(); } catch { }
        instanceMutex?.Dispose();
        instanceMutex = null;
        base.OnExit(e);
    }
}
