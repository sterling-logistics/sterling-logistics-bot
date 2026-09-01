using System.Threading;

namespace Sterling.Logistics.Tracker;

public partial class App : System.Windows.Application
{
    private Mutex? _singleInstance;

    protected override void OnStartup(System.Windows.StartupEventArgs e)
    {
        _singleInstance = new Mutex(true, "Local\\SterlingLogisticsTachographV2", out var createdNew);
        if (!createdNew)
        {
            Shutdown();
            return;
        }
        base.OnStartup(e);
    }

    protected override void OnExit(System.Windows.ExitEventArgs e)
    {
        try { _singleInstance?.ReleaseMutex(); } catch (ApplicationException) { }
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
