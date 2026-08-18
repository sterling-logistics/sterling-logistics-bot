using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace SterlingTracker.Desktop;

public partial class MainWindow
{
    readonly string jobHistoryPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sterling Logistics", "jobs-history.json");
    readonly List<LocalJobHistoryItem> localJobHistory = new();
    bool lastHistoryDelivered;
    string historyCargo = "", historySource = "", historyDestination = "", historyTruck = "";
    double historyIncome, historyDistanceKm;

    void LoadJobHistory()
    {
        try
        {
            localJobHistory.Clear();
            if (File.Exists(jobHistoryPath))
            {
                var items = JsonSerializer.Deserialize<List<LocalJobHistoryItem>>(File.ReadAllText(jobHistoryPath));
                if (items is not null) localJobHistory.AddRange(items.OrderByDescending(x => x.CompletedAt));
            }
        }
        catch { }
        RenderJobHistory();
    }

    async Task RefreshServerJobHistory()
    {
        if (string.IsNullOrWhiteSpace(sessionToken)) { LoadJobHistory(); return; }
        try
        {
            using var req = Authorized(HttpMethod.Get, "/api/tracker/jobs");
            using var res = await apiHttp.SendAsync(req);
            if (!res.IsSuccessStatusCode) { LoadJobHistory(); return; }
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            if (!doc.RootElement.TryGetProperty("jobs", out var jobs) || jobs.ValueKind != JsonValueKind.Array) { LoadJobHistory(); return; }
            var server = new List<LocalJobHistoryItem>();
            foreach (var j in jobs.EnumerateArray())
            {
                var status = j.TryGetProperty("status", out var st) ? st.GetString() ?? "" : "";
                if (!status.Equals("completed", StringComparison.OrdinalIgnoreCase)) continue;
                var completed = DateTime.Now;
                if (j.TryGetProperty("completed_at", out var ca) && ca.ValueKind == JsonValueKind.String) DateTime.TryParse(ca.GetString(), out completed);
                server.Add(new LocalJobHistoryItem
                {
                    CompletedAt = completed,
                    JobCode = j.TryGetProperty("job_code", out var jc) ? jc.GetString() ?? "" : "",
                    Cargo = j.TryGetProperty("cargo", out var c) ? c.GetString() ?? "Unknown cargo" : "Unknown cargo",
                    Source = j.TryGetProperty("origin_city", out var s) ? s.GetString() ?? "Unknown" : "Unknown",
                    Destination = j.TryGetProperty("destination_city", out var d) ? d.GetString() ?? "Unknown" : "Unknown",
                    Truck = j.TryGetProperty("truck_model", out var t) ? t.GetString() ?? "Truck" : "Truck",
                    DistanceMiles = j.TryGetProperty("distance_miles", out var dm) && dm.TryGetDouble(out var miles) ? miles : 0,
                    Revenue = j.TryGetProperty("income", out var i) && i.TryGetDouble(out var income) ? income : 0,
                    Damage = j.TryGetProperty("truck_damage", out var td) && td.TryGetDouble(out var damage) ? damage : 0
                });
            }
            localJobHistory.Clear();
            localJobHistory.AddRange(server.OrderByDescending(x => x.CompletedAt).Take(100));
            SaveJobHistory();
            RenderJobHistory();
            FooterText.Text = $"Jobs synced with Sterling • {localJobHistory.Count} completed";
        }
        catch { LoadJobHistory(); }
    }

    void ObserveJobHistoryFrame(JsonElement d)
    {
        if (BoolAny(d, "SpecialEventsValues.OnJob"))
        {
            historyCargo = First(StrAny(d, "JobValues.CargoValues.Name"), historyCargo);
            historySource = First(StrAny(d, "JobValues.CitySource"), historySource);
            historyDestination = First(StrAny(d, "JobValues.CityDestination"), historyDestination);
            var truck = (StrAny(d, "TruckValues.ConstantsValues.Brand") + " " + First(StrAny(d, "TruckValues.ConstantsValues.Name"), StrAny(d, "TruckValues.ConstantsValues.Model"))).Trim();
            historyTruck = First(truck, historyTruck);
            var income = NumAny(d, "JobValues.Income"); if (income > 0) historyIncome = income;
            var km = FirstNum(d, "JobValues.PlannedDistanceKm", "NavigationValues.NavigationDistance"); if (km > 0) historyDistanceKm = km > 10000 ? km / 1000.0 : km;
        }

        var delivered = BoolAny(d, "SpecialEventsValues.JobDelivered");
        if (delivered && !lastHistoryDelivered)
        {
            var revenue = FirstNum(d, "GamePlay.JobDelivered.Revenue", "JobValues.Income");
            var distanceKm = FirstNum(d, "GamePlay.JobDelivered.DistanceKm", "JobValues.PlannedDistanceKm");
            var item = new LocalJobHistoryItem
            {
                CompletedAt = DateTime.Now,
                Cargo = First(StrAny(d, "JobValues.CargoValues.Name"), historyCargo, "Unknown cargo"),
                Source = First(StrAny(d, "JobValues.CitySource"), historySource, "Unknown"),
                Destination = First(StrAny(d, "JobValues.CityDestination"), historyDestination, "Unknown"),
                Truck = First(historyTruck, "Truck"),
                DistanceMiles = Math.Max(0, (distanceKm > 0 ? distanceKm : historyDistanceKm) * 0.621371),
                Revenue = revenue > 0 ? revenue : historyIncome,
                Damage = Math.Max(0, MaxDamage(d))
            };
            localJobHistory.Insert(0, item);
            if (localJobHistory.Count > 100) localJobHistory.RemoveRange(100, localJobHistory.Count - 100);
            SaveJobHistory();
            RenderJobHistory();
            FooterText.Text = $"Job completed • syncing {item.Source} → {item.Destination}";
            _ = Task.Run(async () => { await Task.Delay(1800); await Dispatcher.InvokeAsync(async () => await RefreshServerJobHistory()); });
            historyCargo = historySource = historyDestination = historyTruck = "";
            historyIncome = historyDistanceKm = 0;
        }
        lastHistoryDelivered = delivered;
    }

    void SaveJobHistory()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(jobHistoryPath)!);
            File.WriteAllText(jobHistoryPath, JsonSerializer.Serialize(localJobHistory, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex) { FooterText.Text = "Could not cache job history • " + ex.Message; }
    }

    void RenderJobHistory()
    {
        if (JobsHistoryPage is null) return;
        JobsHistoryPage.Children.Clear();
        var outer = new Border { Background = new SolidColorBrush(Color.FromRgb(11,22,33)), BorderBrush = new SolidColorBrush(Color.FromRgb(25,51,75)), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Padding = new Thickness(18) };
        var root = new StackPanel();
        root.Children.Add(new TextBlock { Text = "JOBS HISTORY", Foreground = new SolidColorBrush(Color.FromRgb(76,181,255)), FontWeight = FontWeights.Bold, FontSize = 10 });
        root.Children.Add(new TextBlock { Text = localJobHistory.Count == 0 ? "No completed jobs recorded yet" : $"{localJobHistory.Count} completed job{(localJobHistory.Count == 1 ? "" : "s")} • Sterling server history", FontSize = 20, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0,10,0,14) });
        var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        var list = new StackPanel();
        foreach (var j in localJobHistory.Take(50))
        {
            var card = new Border { Background = new SolidColorBrush(Color.FromRgb(7,18,28)), BorderBrush = new SolidColorBrush(Color.FromRgb(23,51,73)), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(14), Margin = new Thickness(0,0,0,9) };
            var grid = new Grid();grid.ColumnDefinitions.Add(new ColumnDefinition());grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var left = new StackPanel();left.Children.Add(new TextBlock { Text = $"{j.Source}  →  {j.Destination}", FontSize = 17, FontWeight = FontWeights.SemiBold });left.Children.Add(new TextBlock { Text = $"{j.Cargo} • {j.Truck}{(string.IsNullOrWhiteSpace(j.JobCode)?"":$" • {j.JobCode}")}", Foreground = new SolidColorBrush(Color.FromRgb(135,158,177)), Margin = new Thickness(0,4,0,0) });
            var right = new StackPanel { HorizontalAlignment = HorizontalAlignment.Right };right.Children.Add(new TextBlock { Text = $"{j.DistanceMiles:0.0} mi", HorizontalAlignment = HorizontalAlignment.Right, FontWeight = FontWeights.SemiBold });right.Children.Add(new TextBlock { Text = j.Revenue > 0 ? $"£{j.Revenue:N0} • {j.CompletedAt:g}" : j.CompletedAt.ToString("g"), Foreground = new SolidColorBrush(Color.FromRgb(63,227,152)), HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0,4,0,0) });
            Grid.SetColumn(right,1);grid.Children.Add(left);grid.Children.Add(right);card.Child=grid;list.Children.Add(card);
        }
        scroll.Content=list;root.Children.Add(scroll);outer.Child=root;JobsHistoryPage.Children.Add(outer);
    }

    sealed class LocalJobHistoryItem
    {
        public DateTime CompletedAt { get; set; }
        public string JobCode { get; set; } = "";
        public string Cargo { get; set; } = "";
        public string Source { get; set; } = "";
        public string Destination { get; set; } = "";
        public string Truck { get; set; } = "";
        public double DistanceMiles { get; set; }
        public double Revenue { get; set; }
        public double Damage { get; set; }
    }
}
