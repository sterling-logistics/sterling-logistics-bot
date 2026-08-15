using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;

namespace SterlingTracker.Desktop;

public partial class MainWindow
{
    readonly Dictionary<string, Grid> pages = new(StringComparer.OrdinalIgnoreCase);

    protected override void OnContentRendered(EventArgs e)
    {
        base.OnContentRendered(e);
        pages["Dashboard"] = DashboardPage;
        pages["Live Drive"] = LiveDrivePage;
        pages["Current Job"] = CurrentJobPage;
        pages["Driver Profile"] = DriverProfilePage;
        pages["DriveScore"] = DriveScorePage;
        pages["Jobs History"] = JobsHistoryPage;
        pages["Finances"] = FinancesPage;
        pages["Convoys"] = ConvoysPage;
        pages["Settings"] = SettingsPage;
        LoadJobHistory();
        ActivatePage("Dashboard");
    }

    void NavButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button button)
            ActivatePage(button.Tag?.ToString() ?? "Dashboard");
    }

    void ActivatePage(string page)
    {
        foreach (var view in pages.Values) view.Visibility = Visibility.Collapsed;
        if (!pages.TryGetValue(page, out var selected))
        {
            page = "Dashboard";
            selected = DashboardPage;
        }
        if (page == "Jobs History") RenderJobHistory();
        selected.Visibility = Visibility.Visible;

        PageTitleText.Text = page;
        PageSubtitleText.Text = page switch
        {
            "Dashboard" => "Live ETS2 telemetry and Sterling operations at a glance",
            "Live Drive" => "Fast local telemetry read directly from ETS2 shared memory",
            "Current Job" => "Your active delivery route cargo value and driver share",
            "Driver Profile" => "Sterling identity rank truck and connection status",
            "DriveScore" => "Driving performance safety and efficiency overview",
            "Jobs History" => "Completed ETS2 deliveries saved automatically by Sterling Tracker",
            "Finances" => "Driver earnings current job share and company tracking",
            "Convoys" => "Sterling convoy operations and live-session readiness",
            "Settings" => "Tracker connection account telemetry and startup settings",
            _ => "Sterling Tracker"
        };

        FooterText.Text = page switch
        {
            "Dashboard" => "Dashboard active • direct shared-memory telemetry",
            "Live Drive" => $"Live Drive • {SpeedText.Text} • {RpmText.Text} rpm • limit {SpeedLimitText.Text}",
            "Current Job" => $"Current Job • {RouteText.Text} • {CargoText.Text}",
            "Driver Profile" => $"Driver Profile • {DriverNameText.Text} • {RankText.Text}",
            "DriveScore" => "DriveScore • performance updates while you drive",
            "Jobs History" => $"Jobs History • {localJobHistory.Count} completed job{(localJobHistory.Count == 1 ? "" : "s")} saved",
            "Finances" => $"Finances • estimated current driver share {DriverShareText.Text}",
            "Convoys" => "Convoys • Sterling multiplayer operations",
            "Settings" => "Settings • tracker configuration",
            _ => page
        };
    }
}
