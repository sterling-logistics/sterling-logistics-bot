using System.ComponentModel;
using System.Drawing;
using System.Windows;
using Forms = System.Windows.Forms;
using Sterling.Logistics.Tracker.Services;

namespace Sterling.Logistics.Tracker;

public partial class MainWindow : Window
{
    private readonly SterlingApiClient _api = new();
    private readonly SecureSessionStore _sessionStore = new();
    private readonly ScsTelemetryService _telemetry = new();
    private readonly TrackerAgent _agent;
    private readonly PayoutWorker _payoutWorker;
    private readonly Forms.NotifyIcon _trayIcon;
    private bool _allowClose;
    private bool _trayHintShown;

    public MainWindow()
    {
        InitializeComponent();
        _agent = new TrackerAgent(_api, new GameDetector(), _sessionStore, _telemetry, new JobSyncStateStore());
        _payoutWorker = new PayoutWorker(_api, _agent, new PayoutJournal());

        _trayIcon = new Forms.NotifyIcon
        {
            Text = "Sterling Tachograph",
            Icon = SystemIcons.Application,
            Visible = true,
            ContextMenuStrip = BuildTrayMenu()
        };
        _trayIcon.DoubleClick += (_, _) => Dispatcher.Invoke(ShowFromTray);

        _agent.StatusChanged += (_, status) => Dispatcher.Invoke(() =>
        {
            var game = status.GameRunning ? $" · {status.Game?.ToUpperInvariant()} detected" : string.Empty;
            StatusText.Text = $"{status.Message}{game}";
            _trayIcon.Text = BuildTrayText(status.Message, status.Game, status.GameRunning);
        });
        _payoutWorker.StatusChanged += (_, message) => Dispatcher.Invoke(() =>
        {
            StatusText.Text = message;
            _trayIcon.Text = BuildTrayText(message, null, false);
        });

        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;
        Closed += MainWindow_Closed;
        StateChanged += MainWindow_StateChanged;
        StatusText.Text = "Ready to connect.";
    }

    private Forms.ContextMenuStrip BuildTrayMenu()
    {
        var menu = new Forms.ContextMenuStrip();
        var open = new Forms.ToolStripMenuItem("Open Sterling Tachograph");
        open.Click += (_, _) => Dispatcher.Invoke(ShowFromTray);
        var exit = new Forms.ToolStripMenuItem("Exit Sterling Tachograph");
        exit.Click += (_, _) => Dispatcher.Invoke(ExitApplication);
        menu.Items.Add(open);
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(exit);
        return menu;
    }

    private static string BuildTrayText(string message, string? game, bool gameRunning)
    {
        var suffix = gameRunning && !string.IsNullOrWhiteSpace(game) ? $" · {game.ToUpperInvariant()}" : string.Empty;
        var value = $"Sterling Tachograph · {message}{suffix}";
        return value.Length <= 63 ? value : value[..63];
    }

    private void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        // A fresh launch always requires an explicit sign-in. This prevents a
        // previous installation's DPAPI session from making a clean install
        // appear authenticated before the driver has entered credentials.
        _sessionStore.Clear();
        PasswordBox.Clear();
        UsernameBox.IsEnabled = true;
        PasswordBox.IsEnabled = true;
        RememberMeBox.IsEnabled = true;
        SignInButton.IsEnabled = true;
        SignInButton.Content = "Sign in";
        StatusText.Text = "Sign in to connect Sterling Tachograph.";
    }

    private async void SignInButton_Click(object sender, RoutedEventArgs e)
    {
        var username = UsernameBox.Text.Trim();
        var password = PasswordBox.Password;
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            StatusText.Text = "Enter your Sterling username and password.";
            return;
        }

        SignInButton.IsEnabled = false;
        StatusText.Text = "Signing in securely...";
        try
        {
            var session = await _api.LoginAsync(username, password);
            PasswordBox.Clear();
            if (RememberMeBox.IsChecked == true)
                _sessionStore.Save(session);
            else
                _sessionStore.Clear();

            StartAgent(session);
            UsernameBox.IsEnabled = false;
            PasswordBox.IsEnabled = false;
            RememberMeBox.IsEnabled = false;
            SignInButton.Content = $"Signed in as {session.User.DisplayName}";
            StatusText.Text = "Connected to Sterling. Waiting for ETS2/ATS telemetry.";
        }
        catch (SterlingApiException ex)
        {
            StatusText.Text = ex.Message;
            SignInButton.IsEnabled = true;
        }
        catch
        {
            StatusText.Text = "Sterling server is currently unavailable. Please try again.";
            SignInButton.IsEnabled = true;
        }
    }

    private void StartAgent(LoginResponse session)
    {
        _agent.Start(session);
        _payoutWorker.Start();
        SignInButton.IsEnabled = false;
    }

    private void MainWindow_StateChanged(object? sender, EventArgs e)
    {
        if (WindowState == WindowState.Minimized)
            HideToTray();
    }

    private void MainWindow_Closing(object? sender, CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        HideToTray();
    }

    private void HideToTray()
    {
        Hide();
        ShowInTaskbar = false;
        if (_trayHintShown) return;
        _trayHintShown = true;
        _trayIcon.BalloonTipTitle = "Sterling Tachograph is still running";
        _trayIcon.BalloonTipText = "Telemetry and Sterling jobs continue safely in the background. Double-click the tray icon to reopen.";
        _trayIcon.ShowBalloonTip(4000);
    }

    private void ShowFromTray()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = WindowState.Normal;
        Activate();
        Topmost = true;
        Topmost = false;
        Focus();
    }

    private void ExitApplication()
    {
        _allowClose = true;
        Close();
    }

    private async void MainWindow_Closed(object? sender, EventArgs e)
    {
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        await _payoutWorker.DisposeAsync();
        await _agent.DisposeAsync();
        System.Windows.Application.Current.Shutdown();
    }
}
