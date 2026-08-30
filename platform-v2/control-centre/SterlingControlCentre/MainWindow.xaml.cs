using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Threading;
using Sterling.Logistics.ControlCentre.Services;

namespace Sterling.Logistics.ControlCentre;

public partial class MainWindow : Window
{
    private readonly ControlCentreApiClient _api = new();
    private readonly DispatcherTimer _refreshTimer;
    private readonly ObservableCollection<LiveDriver> _drivers = new();
    private readonly ObservableCollection<string> _jobs = new();

    public MainWindow()
    {
        InitializeComponent();
        DriversGrid.ItemsSource = _drivers;
        JobsList.ItemsSource = _jobs;
        _refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _refreshTimer.Tick += async (_, _) => await RefreshDashboardAsync();
    }

    private async void LoginButton_Click(object sender, RoutedEventArgs e)
    {
        var username = UsernameBox.Text.Trim();
        var password = PasswordBox.Password;
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            StatusText.Text = "Enter Owner/Founder username and password.";
            return;
        }

        LoginButton.IsEnabled = false;
        StatusText.Text = "Securing Owner/Founder session...";
        try
        {
            await _api.LoginOwnerAsync(username, password);
            PasswordBox.Clear();
            UsernameBox.IsEnabled = false;
            PasswordBox.IsEnabled = false;
            LoginButton.Content = "Owner Connected";
            OwnerNameText.Text = _api.CurrentOwner?.DisplayName ?? username;
            OwnerStatusText.Text = "Owner / Founder · Online";
            OwnerMenuButton.IsEnabled = true;
            LiveMapButton.IsEnabled = true;
            StatusText.Text = "Connected to Sterling Platform. Live operations active.";
            await RefreshDashboardAsync();
            _refreshTimer.Start();
        }
        catch (UnauthorizedAccessException ex)
        {
            StatusText.Text = ex.Message;
            LoginButton.IsEnabled = true;
        }
        catch (Exception ex)
        {
            StatusText.Text = ex.Message;
            LoginButton.IsEnabled = true;
        }
    }

    private void LiveMapButton_Click(object sender, RoutedEventArgs e)
    {
        if (!_api.IsOwnerSignedIn)
        {
            StatusText.Text = "Owner/Founder authentication is required for the live map.";
            return;
        }
        new LiveMapWindow(_api) { Owner = this }.Show();
    }

    private void OwnerMenuButton_Click(object sender, RoutedEventArgs e)
    {
        if (!_api.IsOwnerSignedIn)
        {
            StatusText.Text = "Owner/Founder authentication is required.";
            return;
        }
        var window = new OwnerOperationsWindow(_api) { Owner = this };
        window.ShowDialog();
        _ = RefreshDashboardAsync();
    }

    private async Task RefreshDashboardAsync()
    {
        if (_api.CurrentOwner is null) return;
        try
        {
            var summaryTask = _api.GetSummaryAsync();
            var driversTask = _api.GetLiveDriversAsync();
            var jobsTask = _api.GetJobsAsync();
            await Task.WhenAll(summaryTask, driversTask, jobsTask);

            var summary = summaryTask.Result;
            OnlineDriversText.Text = $"{summary.OnlineDrivers}/{summary.ActiveDrivers}";
            OnJobText.Text = summary.OnJob.ToString();
            JobsInProgressText.Text = summary.JobsInProgress.ToString();
            ApprovalsText.Text = summary.PendingApprovals.ToString();
            PayoutsText.Text = summary.PendingPayouts.ToString();
            FailedPayoutsText.Text = summary.FailedPayouts.ToString();

            _drivers.Clear();
            foreach (var driver in driversTask.Result) _drivers.Add(driver);

            _jobs.Clear();
            foreach (var job in jobsTask.Result.Take(20))
                _jobs.Add($"{job.DriverDisplayName} · {job.OriginCity} → {job.DestinationCity} · {job.Status}");

            StatusText.Text = $"Live data updated {DateTime.Now:HH:mm:ss}.";
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Live update problem: {ex.Message}";
        }
    }
}
