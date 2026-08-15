using System.Windows;
using System.Windows.Controls;

namespace SterlingTracker.Desktop;

public partial class MainWindow
{
    void NavButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button) return;
        var page = button.Tag?.ToString() ?? "Dashboard";

        FooterText.Text = page switch
        {
            "Dashboard" => "Dashboard active • live Sterling overview",
            "Live Drive" => $"Live Drive • {SpeedText.Text} • {RpmText.Text} rpm • limit {SpeedLimitText.Text}",
            "Current Job" => $"Current Job • {RouteText.Text} • {CargoText.Text}",
            "Driver Profile" => $"Driver Profile • {DriverNameText.Text} • {RankText.Text}",
            "DriveScore" => "DriveScore • live driving performance and safety scoring",
            "Jobs History" => "Jobs History • completed Sterling deliveries",
            "Finances" => $"Finances • estimated current driver share {DriverPayText.Text}",
            "Convoys" => "Convoys • Sterling convoy operations",
            "Settings" => "Settings • tracker account and application configuration",
            _ => page
        };

        StatusText.Text = page == "Dashboard" ? "Sterling Connected" : page;
    }
}
