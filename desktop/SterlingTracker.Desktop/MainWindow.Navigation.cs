using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace SterlingTracker.Desktop;

public partial class MainWindow
{
    readonly Dictionary<TextBlock, string> navigation = new();

    protected override void OnContentRendered(EventArgs e)
    {
        base.OnContentRendered(e);
        WireNavigation(this);
        RepairBrandImage(this);
    }

    void WireNavigation(DependencyObject root)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is TextBlock text)
            {
                var label = text.Text?.Trim() ?? "";
                var page = label switch
                {
                    var x when x.Contains("Dashboard") => "Dashboard",
                    var x when x.Contains("Live Drive") => "Live Drive",
                    var x when x.Contains("Current Job") => "Current Job",
                    var x when x.Contains("Driver Profile") => "Driver Profile",
                    var x when x.Contains("DriveScore") => "DriveScore",
                    var x when x.Contains("Jobs History") => "Jobs History",
                    var x when x.Contains("Finances") => "Finances",
                    var x when x.Contains("Convoys") => "Convoys",
                    var x when x.Contains("Settings") => "Settings",
                    _ => ""
                };
                if (page.Length > 0 && !navigation.ContainsKey(text))
                {
                    navigation[text] = page;
                    text.Cursor = Cursors.Hand;
                    text.ToolTip = $"Open {page}";
                    text.MouseLeftButtonUp += NavText_Click;
                    text.MouseEnter += (_, _) => text.Foreground = Brushes.White;
                    text.MouseLeave += (_, _) => text.Foreground = page == "Dashboard" ? Brushes.White : new SolidColorBrush(Color.FromRgb(154,175,196));
                }
            }
            WireNavigation(child);
        }
    }

    void RepairBrandImage(DependencyObject root)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is Image image && image.Width >= 100 && image.Height >= 100)
            {
                var visual = new DrawingVisual();
                using (var dc = visual.RenderOpen())
                {
                    dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromRgb(7,18,30)), new Pen(new SolidColorBrush(Color.FromRgb(30,112,178)), 3), new Rect(2,2,108,108), 22,22);
                    var sl = new FormattedText("SL", System.Globalization.CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI"), 42, Brushes.White, 1.0);
                    dc.DrawText(sl, new Point((112-sl.Width)/2,20));
                    var tracker = new FormattedText("TRACKER", System.Globalization.CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI Semibold"), 12, new SolidColorBrush(Color.FromRgb(43,156,255)), 1.0);
                    dc.DrawText(tracker, new Point((112-tracker.Width)/2,75));
                }
                var bitmap = new RenderTargetBitmap(112,112,96,96,PixelFormats.Pbgra32);
                bitmap.Render(visual); bitmap.Freeze(); image.Source = bitmap;
                return;
            }
            RepairBrandImage(child);
        }
    }

    void NavText_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is TextBlock text && navigation.TryGetValue(text, out var page)) ActivatePage(page);
    }

    void NavButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button button) ActivatePage(button.Tag?.ToString() ?? "Dashboard");
    }

    void ActivatePage(string page)
    {
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
