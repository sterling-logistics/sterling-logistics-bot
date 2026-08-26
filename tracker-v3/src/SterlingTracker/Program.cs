using System.Text;
using System.Windows.Forms;

namespace SterlingTracker;

internal static class Program
{
    private static readonly string CrashLogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Sterling Logistics", "Tracker", "crash.log");

    [STAThread]
    private static void Main()
    {
        using var singleInstance = new Mutex(true, "SterlingLogistics.SterlingTracker.v3", out var createdNew);
        if (!createdNew)
        {
            MessageBox.Show("Sterling Tracker is already running. Check the system tray.", "Sterling Tracker", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => HandleCrash("UI", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => HandleCrash("AppDomain", e.ExceptionObject as Exception ?? new Exception(e.ExceptionObject?.ToString() ?? "Unknown error"));
        TaskScheduler.UnobservedTaskException += (_, e) => { HandleCrash("Task", e.Exception); e.SetObserved(); };
        Application.Run(new MainForm());
    }

    private static void HandleCrash(string source, Exception ex)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(CrashLogPath)!);
            var text = $"[{DateTimeOffset.Now:O}] {source} crash{Environment.NewLine}{CompatibilityInfo.RuntimeSummary()}{Environment.NewLine}{ex}{Environment.NewLine}{new string('-', 80)}{Environment.NewLine}";
            File.AppendAllText(CrashLogPath, text, Encoding.UTF8);
        }
        catch { }

        try
        {
            MessageBox.Show($"Sterling Tracker encountered an error and recorded a diagnostic log.\n\n{ex.Message}", "Sterling Tracker", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch { }
    }
}
