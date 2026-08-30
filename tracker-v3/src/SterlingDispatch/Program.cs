namespace SterlingTracker;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, "SterlingLogistics.SterlingDispatch.v1", out var firstInstance);
        if (!firstInstance)
        {
            MessageBox.Show("Sterling Dispatch is already running.", "Sterling Dispatch", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => WriteCrash(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => WriteCrash(e.ExceptionObject as Exception ?? new Exception(String(e.ExceptionObject)));
        TaskScheduler.UnobservedTaskException += (_, e) => { WriteCrash(e.Exception); e.SetObserved(); };
        Application.Run(new DispatchShell());
    }

    private static void WriteCrash(Exception ex)
    {
        try
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sterling Logistics", "Dispatch");
            Directory.CreateDirectory(root);
            File.AppendAllText(Path.Combine(root, "crash.log"), $"[{DateTimeOffset.Now:O}] Sterling Dispatch 1.0.0{Environment.NewLine}{ex}{Environment.NewLine}{Environment.NewLine}");
        }
        catch { }
    }
}
