using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Sterling.Logistics.ControlCentre.Services;

namespace Sterling.Logistics.ControlCentre;

public partial class OwnerDataWindow : Window
{
    private readonly ControlCentreApiClient _api;
    private readonly DispatcherTimer _refreshTimer;
    private bool _loaded;
    private bool _refreshing;

    public OwnerDataWindow(ControlCentreApiClient api, string? initialTab = null)
    {
        InitializeComponent();
        _api = api;
        _refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _refreshTimer.Tick += async (_, _) => await RefreshCurrentAsync();
        Loaded += async (_, _) =>
        {
            SelectTab(initialTab);
            _loaded = true;
            await RefreshCurrentAsync();
            _refreshTimer.Start();
        };
        Closed += (_, _) => _refreshTimer.Stop();
    }

    private void SelectTab(string? tab)
    {
        var index = (tab ?? string.Empty).ToLowerInvariant() switch
        {
            "drivers" => 0,
            "jobs" => 1,
            "approvals" => 2,
            "payments" or "finance" => 3,
            "audit" => 4,
            "system" => 5,
            _ => 0
        };
        Tabs.SelectedIndex = index;
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await RefreshCurrentAsync();

    private async void Tabs_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loaded && e.Source == Tabs) await RefreshCurrentAsync();
    }

    private async Task RefreshCurrentAsync()
    {
        if (!_api.IsOwnerSignedIn || _refreshing) return;
        _refreshing = true;
        try
        {
            StatusText.Text = "Refreshing Sterling data...";
            switch (Tabs.SelectedIndex)
            {
                case 0:
                    DriversGrid.ItemsSource = await _api.GetDriversAsync();
                    if (DriversGrid.SelectedItem is OwnerDriver selectedDriver)
                        await RefreshDriverHistoryAsync(selectedDriver);
                    break;
                case 1:
                    JobsGrid.ItemsSource = await _api.GetJobsAsync();
                    break;
                case 2:
                    ApprovalsGrid.ItemsSource = await _api.GetPendingReviewAsync();
                    break;
                case 3:
                    PayoutsGrid.ItemsSource = await _api.GetPayoutsAsync();
                    break;
                case 4:
                    AuditGrid.ItemsSource = await _api.GetAuditAsync();
                    break;
                case 5:
                    var health = await _api.GetSystemHealthAsync();
                    SystemApiText.Text = health.Api.ToUpperInvariant();
                    SystemDatabaseText.Text = health.Database.ToUpperInvariant();
                    SystemJobsText.Text = health.TotalJobs.ToString();
                    SystemFailedText.Text = health.FailedPayouts.ToString();
                    SystemDetailText.Text = $"Platform {health.Version} · {health.ActiveAccounts} active accounts · {health.TotalPayouts} payouts · server {health.ServerTime.ToLocalTime():g}";
                    break;
            }
            StatusText.Text = $"Live data updated {DateTime.Now:HH:mm:ss}.";
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Could not refresh: {ex.Message}";
        }
        finally
        {
            _refreshing = false;
        }
    }

    private async void DriversGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (DriversGrid.SelectedItem is not OwnerDriver driver) return;
        try
        {
            await RefreshDriverHistoryAsync(driver);
        }
        catch (Exception ex)
        {
            DriverStatsText.Text = $"Could not load driver history: {ex.Message}";
        }
    }

    private async Task RefreshDriverHistoryAsync(OwnerDriver driver)
    {
        var history = await _api.GetDriverHistoryAsync(driver.Id);
        DriverStatsText.Text = $"{history.Driver.DisplayName} · {history.Stats.CompletedJobs}/{history.Stats.TotalJobs} completed · {history.Stats.TotalDistanceKm:0} km · {history.Stats.TotalPaid:0} paid";
        DriverHistoryGrid.ItemsSource = history.Jobs.Select(job => new DriverHistoryRow(
            job.CreatedAt,
            $"{job.OriginCity} → {job.DestinationCity}",
            job.Status,
            job.PayoutAmount)).ToArray();
    }

    private async void ApproveButton_Click(object sender, RoutedEventArgs e)
    {
        if (ApprovalsGrid.SelectedItem is not PendingReviewJob job)
        {
            StatusText.Text = "Select a submitted job first.";
            return;
        }
        try
        {
            await _api.ApproveJobAsync(job.Id, ReviewNotesBox.Text.Trim());
            ReviewNotesBox.Clear();
            StatusText.Text = $"Approved {job.DriverDisplayName}'s job.";
            await RefreshCurrentAsync();
        }
        catch (Exception ex)
        {
            StatusText.Text = ex.Message;
        }
    }

    private async void DeclineButton_Click(object sender, RoutedEventArgs e)
    {
        if (ApprovalsGrid.SelectedItem is not PendingReviewJob job)
        {
            StatusText.Text = "Select a submitted job first.";
            return;
        }
        try
        {
            await _api.DeclineJobAsync(job.Id, ReviewNotesBox.Text.Trim());
            ReviewNotesBox.Clear();
            StatusText.Text = $"Declined {job.DriverDisplayName}'s job.";
            await RefreshCurrentAsync();
        }
        catch (Exception ex)
        {
            StatusText.Text = ex.Message;
        }
    }
}

public sealed record DriverHistoryRow(DateTime CreatedAt, string Route, string Status, decimal PayoutAmount);
