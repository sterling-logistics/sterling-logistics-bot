using System.Windows;
using Sterling.Logistics.Tracker.Services;

namespace Sterling.Logistics.Tracker;

public partial class MainWindow : Window
{
    private readonly SterlingApiClient _api = new();
    private readonly SecureSessionStore _sessionStore = new();
    private readonly TrackerAgent _agent;
    private readonly PayoutWorker _payoutWorker;

    public MainWindow()
    {
        InitializeComponent();
        _agent = new TrackerAgent(_api, new GameDetector(), _sessionStore);
        _payoutWorker = new PayoutWorker(_api, _agent, new PayoutJournal());
        _agent.StatusChanged += (_, status) => Dispatcher.Invoke(() =>
        {
            var game = status.GameRunning ? $" · {status.Game?.ToUpperInvariant()} detected" : string.Empty;
            StatusText.Text = $"{status.Message}{game}";
        });
        _payoutWorker.StatusChanged += (_, message) => Dispatcher.Invoke(() => StatusText.Text = message);
        Loaded += MainWindow_Loaded;
        Closed += MainWindow_Closed;
        StatusText.Text = "Ready to connect.";
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        var remembered = _sessionStore.Load();
        if (remembered is null) return;

        StatusText.Text = "Restoring secure Sterling session...";
        try
        {
            var refreshed = await _api.RefreshAsync(remembered.RefreshToken);
            _sessionStore.Save(refreshed);
            StartAgent(refreshed);
            UsernameBox.Text = refreshed.User.Username;
            PasswordBox.IsEnabled = false;
            UsernameBox.IsEnabled = false;
            SignInButton.IsEnabled = false;
            SignInButton.Content = $"Signed in as {refreshed.User.DisplayName}";
        }
        catch
        {
            _sessionStore.Clear();
            StatusText.Text = "Session expired. Sign in again.";
        }
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
            StatusText.Text = "Connected to Sterling.";
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

    private async void MainWindow_Closed(object? sender, EventArgs e)
    {
        await _payoutWorker.DisposeAsync();
        await _agent.DisposeAsync();
    }
}
