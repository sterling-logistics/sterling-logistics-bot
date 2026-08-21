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
            Text = "Sterling Tracker",
            Visible = true,
            Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? SystemIcons.Application
        };
        trayIcon.DoubleClick += (_, _) => ShowTrackerWindow();

        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open Sterling Tracker", null, (_, _) => ShowTrackerWindow());
        menu.Items.Add("Exit Sterling Tracker", null, (_, _) => ExitTracker());
        trayIcon.ContextMenuStrip = menu;

        Closing += BackgroundClosing;
        Loaded += async (_, _) =>
        {
            await System.Threading.Tasks.Task.Delay(1200);
            if (!string.IsNullOrWhiteSpace(sessionToken)) HideTrackerWindow();
        };

        backgroundTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        backgroundTimer.Tick += (_, _) =>
        {
            if (firstLoginAutoHide && !string.IsNullOrWhiteSpace(sessionToken))
            {
                firstLoginAutoHide = false;
                trayIcon?.ShowBalloonTip(2500, "Sterling Tracker", "Connected. Sterling Tracker is now running in the background and will update Discord automatically.", Forms.ToolTipIcon.Info);
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
        WindowState = WindowState.Normal;
        Activate();
    }

    void ExitTracker()
    {
        allowExit = true;
        running = false;
        backgroundTimer?.Stop();
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
