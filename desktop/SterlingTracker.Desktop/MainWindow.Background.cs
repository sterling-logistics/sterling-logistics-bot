using System;
using System.ComponentModel;
using System.Drawing;
using System.Windows;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace SterlingTracker.Desktop;

public partial class MainWindow
{
    Forms.NotifyIcon? trayIcon;
    Forms.ToolStripMenuItem? statusItem;
    bool allowExit;
    bool firstLoginAutoHide;
    DispatcherTimer? backgroundTimer;

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        SetupBackgroundMode();
    }

    void SetupBackgroundMode()
    {
        firstLoginAutoHide = string.IsNullOrWhiteSpace(sessionToken);

        trayIcon = new Forms.NotifyIcon
        {
            Text = "Sterling Tracker • starting",
            Visible = true,
            Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? SystemIcons.Application
        };
        trayIcon.DoubleClick += (_, _) => ShowTrackerWindow();

        var menu = new Forms.ContextMenuStrip();
        statusItem = new Forms.ToolStripMenuItem("Status: starting") { Enabled = false };
        menu.Items.Add(statusItem);
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Open Sterling Tracker", null, (_, _) => ShowTrackerWindow());
        menu.Items.Add("Exit Sterling Tracker", null, (_, _) => ExitTracker());
        trayIcon.ContextMenuStrip = menu;

        Closing += BackgroundClosing;
        Loaded += async (_, _) =>
        {
            await System.Threading.Tasks.Task.Delay(900);
            if (!string.IsNullOrWhiteSpace(sessionToken)) HideTrackerWindow();
        };

        backgroundTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        backgroundTimer.Tick += (_, _) =>
        {
            var accountReady = !string.IsNullOrWhiteSpace(sessionToken);
            var status = !accountReady
                ? "sign in required"
                : !gameRunning
                    ? "waiting for ETS2"
                    : LiveStateText.Text.Equals("LIVE", StringComparison.OrdinalIgnoreCase)
                        ? "tracking ETS2 live"
                        : "connecting to telemetry";

            if (statusItem is not null) statusItem.Text = "Status: " + status;
            if (trayIcon is not null) trayIcon.Text = ("Sterling Tracker • " + status).Length <= 63 ? "Sterling Tracker • " + status : "Sterling Tracker";

            if (firstLoginAutoHide && accountReady)
            {
                firstLoginAutoHide = false;
                trayIcon?.ShowBalloonTip(2500, "Sterling Tracker", "Connected. Tracking now runs in the background and Sterling/Discord will update automatically.", Forms.ToolTipIcon.Info);
                HideTrackerWindow();
            }
        };
        backgroundTimer.Start();
    }

    void BackgroundClosing(object? sender, CancelEventArgs e)
    {
        if (allowExit) return;
        if (string.IsNullOrWhiteSpace(sessionToken)) return;
        e.Cancel = true;
        HideTrackerWindow();
    }

    void HideTrackerWindow()
    {
        ShowInTaskbar = false;
        Hide();
    }

    void ShowTrackerWindow()
    {
        Show();
        ShowInTaskbar = true;
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        Topmost = true;
        Topmost = false;
        Focus();
    }

    void ExitTracker()
    {
        allowExit = true;
        running = false;
        backgroundTimer?.Stop();
        backgroundTimer = null;
        if (trayIcon is not null)
        {
            trayIcon.Visible = false;
            trayIcon.Dispose();
            trayIcon = null;
        }
        directTelemetry.Dispose();
        Application.Current.Shutdown();
    }
}
