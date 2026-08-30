using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using Sterling.Logistics.ControlCentre.Services;

namespace Sterling.Logistics.ControlCentre;

public partial class OwnerOperationsWindow : Window
{
    private readonly ControlCentreApiClient _api;

    public OwnerOperationsWindow(ControlCentreApiClient api)
    {
        InitializeComponent();
        _api = api;
        Loaded += async (_, _) => await RefreshDriversAsync();
    }

    private async Task RefreshDriversAsync()
    {
        try
        {
            var drivers = await _api.GetDriversAsync();
            OwnerDriversGrid.ItemsSource = drivers;
            JobDriverBox.ItemsSource = drivers.Where(x => x.IsActive).ToList();
            OwnerOpsStatusText.Text = $"Loaded {drivers.Count} Sterling driver profile(s).";
        }
        catch (Exception ex)
        {
            OwnerOpsStatusText.Text = ex.Message;
        }
    }

    private async void CreateDriverButton_Click(object sender, RoutedEventArgs e)
    {
        CreateDriverButton.IsEnabled = false;
        try
        {
            var created = await _api.CreateDriverAsync(
                DriverUsernameBox.Text.Trim(),
                DriverPasswordBox.Password,
                DriverDisplayNameBox.Text.Trim(),
                string.IsNullOrWhiteSpace(DriverRankBox.Text) ? "Driver" : DriverRankBox.Text.Trim());
            DriverPasswordBox.Clear();
            OwnerOpsStatusText.Text = $"Driver account created: {created.DisplayName} ({created.Username}).";
            await RefreshDriversAsync();
        }
        catch (Exception ex)
        {
            OwnerOpsStatusText.Text = ex.Message;
        }
        finally
        {
            CreateDriverButton.IsEnabled = true;
        }
    }

    private async void ResetPasswordButton_Click(object sender, RoutedEventArgs e)
    {
        if (OwnerDriversGrid.SelectedItem is not OwnerDriver driver)
        {
            OwnerOpsStatusText.Text = "Select a driver first.";
            return;
        }
        try
        {
            await _api.SetDriverPasswordAsync(driver.Id, ResetPasswordBox.Password);
            ResetPasswordBox.Clear();
            OwnerOpsStatusText.Text = $"New Sterling password set for {driver.DisplayName}. Existing sessions were revoked.";
        }
        catch (Exception ex) { OwnerOpsStatusText.Text = ex.Message; }
    }

    private async Task SetDriverActiveAsync(bool active)
    {
        if (OwnerDriversGrid.SelectedItem is not OwnerDriver driver)
        {
            OwnerOpsStatusText.Text = "Select a driver first.";
            return;
        }
        try
        {
            await _api.SetDriverActiveAsync(driver.Id, active);
            OwnerOpsStatusText.Text = $"{driver.DisplayName} is now {(active ? "enabled" : "disabled")}.";
            await RefreshDriversAsync();
        }
        catch (Exception ex) { OwnerOpsStatusText.Text = ex.Message; }
    }

    private async void EnableDriverButton_Click(object sender, RoutedEventArgs e) => await SetDriverActiveAsync(true);
    private async void DisableDriverButton_Click(object sender, RoutedEventArgs e) => await SetDriverActiveAsync(false);
    private async void RefreshDriversButton_Click(object sender, RoutedEventArgs e) => await RefreshDriversAsync();

    private async void CreateJobButton_Click(object sender, RoutedEventArgs e)
    {
        if (JobDriverBox.SelectedItem is not OwnerDriver driver)
        {
            OwnerOpsStatusText.Text = "Choose a driver for the job.";
            return;
        }
        var game = (GameBox.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "ets2";
        decimal? distance = null;
        if (!string.IsNullOrWhiteSpace(DistanceBox.Text))
        {
            if (!decimal.TryParse(DistanceBox.Text, NumberStyles.Number, CultureInfo.InvariantCulture, out var parsedDistance))
            {
                OwnerOpsStatusText.Text = "Enter a valid distance.";
                return;
            }
            distance = parsedDistance;
        }
        if (!decimal.TryParse(PayoutBox.Text, NumberStyles.Number, CultureInfo.InvariantCulture, out var payout))
        {
            OwnerOpsStatusText.Text = "Enter a valid payout amount.";
            return;
        }

        try
        {
            var created = await _api.CreateJobAsync(driver.Id, game, CargoBox.Text.Trim(), OriginBox.Text.Trim(), DestinationBox.Text.Trim(), distance, payout);
            OwnerOpsStatusText.Text = $"Job {created.Id:D} assigned to {driver.DisplayName}.";
            CargoBox.Clear(); OriginBox.Clear(); DestinationBox.Clear(); DistanceBox.Clear(); PayoutBox.Clear();
        }
        catch (Exception ex) { OwnerOpsStatusText.Text = ex.Message; }
    }
}
