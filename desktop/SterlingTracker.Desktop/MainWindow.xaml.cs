using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;

namespace SterlingTracker.Desktop;

public partial class MainWindow : Window
{
    readonly HttpClient apiHttp = new() { Timeout = TimeSpan.FromSeconds(8) };
    readonly HttpClient telemetryHttp = new() { Timeout = TimeSpan.FromMilliseconds(400) };
    readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sterling Logistics", "tracker.json");
    const string TelemetryUrl = "http://127.0.0.1:6969/";
    const string ApiBase = "http://45.43.163.175:8101";
    readonly string sessionCode = $"desktop-{Environment.MachineName}-{Guid.NewGuid():N}";
    readonly Dictionary<string, bool> lastFlags = new();
    string sessionToken = "";
    bool running = true, lastOnJob, uploadBusy;
    double? lastGameTime;
    DateTime lastUploadAt = DateTime.MinValue;
    DateTime lastGameCheckAt = DateTime.MinValue;
    bool gameRunning;

    public MainWindow()
    {
        InitializeComponent();
        telemetryHttp.DefaultRequestHeaders.CacheControl = new CacheControlHeaderValue { NoCache = true, NoStore = true };
        telemetryHttp.DefaultRequestHeaders.Pragma.ParseAdd("no-cache");
        foreach (var n in new[] { "JobDelivered", "JobCancelled", "Refuel", "RefuelPayed", "Fined", "Tollgate", "Ferry", "Train" }) lastFlags[n] = false;
        LoadSettings();
        Loaded += async (_, _) => { await RefreshIdentity(); _ = LiveLoop(); };
        Closed += (_, _) => running = false;
    }

    void LoadSettings()
    {
        try
        {
            if (!File.Exists(settingsPath)) return;
            var s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(settingsPath));
            if (!string.IsNullOrWhiteSpace(s?.ProtectedToken)) sessionToken = Unprotect(s.ProtectedToken);
            else if (!string.IsNullOrWhiteSpace(s?.TrackerKey)) sessionToken = s.TrackerKey;
        }
        catch { }
    }

    void SaveToken(string token)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
        File.WriteAllText(settingsPath, JsonSerializer.Serialize(new Settings { ProtectedToken = Protect(token) }));
    }

    void ClearToken()
    {
        sessionToken = "";
        try { if (File.Exists(settingsPath)) File.Delete(settingsPath); } catch { }
        SetSignedOutUi();
    }

    static string Protect(string value) => Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser));
    static string Unprotect(string value) => Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(value), null, DataProtectionScope.CurrentUser));

    async void AccountButton_Click(object sender, RoutedEventArgs e)
    {
        if (!string.IsNullOrWhiteSpace(sessionToken))
        {
            try { using var req = Authorized(HttpMethod.Post, "/auth/desktop/logout"); await apiHttp.SendAsync(req); } catch { }
            ClearToken(); FooterText.Text = "Signed out of Sterling"; return;
        }
        AccountButton.IsEnabled = false;
        try
        {
            StatusText.Text = "Opening Discord sign in"; FooterText.Text = "Complete the secure login in your browser";
            var payload = JsonSerializer.Serialize(new { deviceName = $"{Environment.MachineName} • Windows" });
            using var res = await apiHttp.PostAsync(ApiBase + "/auth/desktop/start", new StringContent(payload, Encoding.UTF8, "application/json"));
            var raw = await res.Content.ReadAsStringAsync(); if (!res.IsSuccessStatusCode) throw new Exception(ReadError(raw));
            using var start = JsonDocument.Parse(raw); var state = start.RootElement.GetProperty("state").GetString()!; var url = start.RootElement.GetProperty("authorizeUrl").GetString()!;
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            for (var n = 0; n < 150; n++)
            {
                await Task.Delay(2000);
                using var poll = await apiHttp.GetAsync(ApiBase + "/auth/desktop/status?state=" + Uri.EscapeDataString(state));
                var text = await poll.Content.ReadAsStringAsync(); if (poll.StatusCode == System.Net.HttpStatusCode.NotFound) throw new Exception("Login expired • try again");
                using var doc = JsonDocument.Parse(text); var status = doc.RootElement.TryGetProperty("status", out var st) ? st.GetString() : "";
                if (status == "complete")
                {
                    sessionToken = doc.RootElement.GetProperty("token").GetString()!; SaveToken(sessionToken); await RefreshIdentity(); FooterText.Text = "Discord account linked securely"; return;
                }
                if (status == "error") throw new Exception(doc.RootElement.TryGetProperty("error", out var er) ? er.GetString() : "Discord login failed");
            }
            throw new Exception("Discord login timed out");
        }
        catch (Exception ex) { FooterText.Text = ex.Message; SetSignedOutUi(); }
        finally { AccountButton.IsEnabled = true; }
    }

    async Task RefreshIdentity()
    {
        if (string.IsNullOrWhiteSpace(sessionToken)) { SetSignedOutUi(); return; }
        try
        {
            using var req = Authorized(HttpMethod.Get, "/api/desktop/me"); using var res = await apiHttp.SendAsync(req); if (!res.IsSuccessStatusCode) { ClearToken(); return; }
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync()); var d = doc.RootElement.GetProperty("driver");
            DriverNameText.Text = d.TryGetProperty("discordUsername", out var u) ? u.GetString() ?? "Sterling Driver" : "Sterling Driver";
            DriverIdText.Text = d.TryGetProperty("sterlingDriverId", out var id) ? id.GetString() ?? "—" : "—";
            RankText.Text = d.TryGetProperty("rank", out var rank) && rank.ValueKind != JsonValueKind.Null ? rank.GetString() ?? "Driver" : "Driver";
            StatusText.Text = "Sterling Connected"; AccountText.Text = $"{DriverIdText.Text}  •  {DriverNameText.Text}"; ConnectionText.Text = "Connected"; AccountButton.Content = "Sign out";
        }
        catch { ConnectionText.Text = "Reconnecting"; }
    }

    void SetSignedOutUi()
    {
        StatusText.Text = "Sterling account not connected"; AccountText.Text = "Sign in with Discord to link your approved Sterling driver profile";
        DriverNameText.Text = "Not signed in"; DriverIdText.Text = "—"; RankText.Text = "—"; ConnectionText.Text = "Offline"; AccountButton.Content = "Sign in with Discord";
    }

    async Task LiveLoop()
    {
        // Local dashboard is intentionally independent of cloud uploads.
        // 50 ms target = 20 refreshes per second for speed/RPM/limit/fuel/gear.
        while (running)
        {
            var frame = Stopwatch.StartNew();
            try
            {
                if ((DateTime.UtcNow - lastGameCheckAt).TotalMilliseconds >= 2000)
                {
                    gameRunning = Process.GetProcessesByName("eurotrucks2").Length > 0;
                    lastGameCheckAt = DateTime.UtcNow;
                }

                if (!gameRunning)
                {
                    GameText.Text = "ETS2 not detected"; TelemetryText.Text = "Waiting for game"; LiveStateText.Text = "WAITING"; PingText.Text = "—";
                    ConnectionText.Text = string.IsNullOrWhiteSpace(sessionToken) ? "Offline" : "Connected";
                    await Task.Delay(250); continue;
                }

                GameText.Text = "ETS2 detected";
                // Unique query string + no-cache headers prevents any HTTP/proxy cache from replaying stale frames.
                var url = TelemetryUrl + "?frame=" + Environment.TickCount64;
                using var response = await telemetryHttp.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
                response.EnsureSuccessStatusCode();
                var json = await response.Content.ReadAsStringAsync();
                using var doc = JsonDocument.Parse(json);
                var raw = doc.RootElement.Clone();

                if (!BoolAny(raw, "SdkActive"))
                {
                    TelemetryText.Text = "SDK waiting"; LiveStateText.Text = "SDK WAITING"; PingText.Text = $"{frame.ElapsedMilliseconds} ms";
                    await Task.Delay(100); continue;
                }

                UpdateUi(raw);
                TelemetryText.Text = "Live telemetry active"; LiveStateText.Text = "LIVE"; PingText.Text = $"{frame.ElapsedMilliseconds} ms";
                LastUpdatedText.Text = DateTime.Now.ToString("HH:mm:ss.fff");

                // Cloud upload is throttled separately and never blocks local live gauges.
                if (!string.IsNullOrWhiteSpace(sessionToken) && !uploadBusy && (DateTime.UtcNow - lastUploadAt).TotalMilliseconds >= 500)
                {
                    lastUploadAt = DateTime.UtcNow; uploadBusy = true; _ = UploadCycle(raw);
                }
            }
            catch (Exception ex)
            {
                TelemetryText.Text = "Telemetry reconnecting"; LiveStateText.Text = "RECONNECTING"; PingText.Text = "—";
                FooterText.Text = ex.Message.Length > 110 ? ex.Message[..110] : ex.Message;
            }

            var wait = 50 - (int)frame.ElapsedMilliseconds;
            if (wait > 0) await Task.Delay(wait);
            else await Task.Yield();
        }
    }

    async Task UploadCycle(JsonElement raw)
    {
        try { await DetectAndSend(raw); }
        catch (Exception ex) { FooterText.Text = ex.Message.Length > 110 ? ex.Message[..110] : ex.Message; }
        finally { uploadBusy = false; }
    }

    async Task DetectAndSend(JsonElement d)
    {
        var onJob = BoolAny(d, "SpecialEventsValues.OnJob"); var eventType = "heartbeat"; var direct = false;
        var gameTime = NumAny(d, "CommonValues.GameTime.Value"); var gameTimeJump = lastGameTime.HasValue && gameTime > 0 ? Math.Max(0, gameTime - lastGameTime.Value) : 0;
        var eventMap = new Dictionary<string, string>{{"JobDelivered","job-delivered"},{"JobCancelled","job-cancelled"},{"Refuel","refuel"},{"RefuelPayed","refuel-paid"},{"Fined","fine"},{"Tollgate","toll"},{"Ferry","ferry"},{"Train","train"}};
        foreach (var pair in eventMap) { var now = BoolAny(d, $"SpecialEventsValues.{pair.Key}"); if (now && !lastFlags[pair.Key]) { eventType = pair.Value; direct = true; break; } }
        if (!direct && gameTimeJump >= 120) { eventType = "rest-stop"; direct = true; }
        if (!direct) { if (onJob && !lastOnJob) { eventType = "job-started"; direct = true; } else if (!onJob && lastOnJob) { eventType = "job-ended"; direct = true; } }
        await SendTelemetry(d, eventType, direct, gameTimeJump);
        lastOnJob = onJob; if (gameTime > 0) lastGameTime = gameTime;
        foreach (var key in eventMap.Keys) lastFlags[key] = BoolAny(d, $"SpecialEventsValues.{key}");
        JobStateText.Text = eventType == "heartbeat" ? (onJob ? "IN PROGRESS" : "WAITING") : eventType.Replace('-', ' ').ToUpperInvariant();
    }

    async Task SendTelemetry(JsonElement d, string eventType, bool direct, double gameTimeJump)
    {
        var speed = SpeedMps(d);
        var data = new Dictionary<string, object?>
        {
            ["game"] = StrAny(d,"Game"), ["paused"] = BoolAny(d,"Paused"), ["sdkActive"] = BoolAny(d,"SdkActive"), ["speedMps"] = speed,
            ["speedLimitMph"] = NumAny(d,"NavigationValues.SpeedLimit.Mph"), ["engineRpm"] = NumAny(d,"TruckValues.CurrentValues.DashboardValues.RPM"),
            ["truck"] = (StrAny(d,"TruckValues.ConstantsValues.Brand") + " " + First(StrAny(d,"TruckValues.ConstantsValues.Name"),StrAny(d,"TruckValues.ConstantsValues.Model"))).Trim(),
            ["cargo"] = StrAny(d,"JobValues.CargoValues.Name"), ["sourceCity"] = StrAny(d,"JobValues.CitySource"), ["destinationCity"] = StrAny(d,"JobValues.CityDestination"),
            ["distanceKm"] = FirstNum(d,"GamePlay.JobDelivered.DistanceKm","JobValues.PlannedDistanceKm"), ["revenue"] = FirstNum(d,"GamePlay.JobDelivered.Revenue","JobValues.Income"),
            ["fuelLiters"] = NumAny(d,"TruckValues.CurrentValues.DashboardValues.FuelValue.Amount"), ["refuelAmount"] = NumAny(d,"GamePlay.RefuelEvent.Amount"),
            ["odometerKm"] = NumAny(d,"TruckValues.CurrentValues.DashboardValues.Odometer"), ["truckDamage"] = MaxDamage(d), ["trailerDamage"] = NumAny(d,"TrailerValues.0.DamageValues.Body"),
            ["cargoDamage"] = FirstNum(d,"JobValues.CargoValues.CargoDamage","GamePlay.JobDelivered.CargoDamage"), ["engineOn"] = BoolAny(d,"TruckValues.CurrentValues.EngineEnabled"),
            ["gameTime"] = NumAny(d,"CommonValues.GameTime.Value"), ["gameTimeJump"] = gameTimeJump, ["latitude"] = NullableNum(d,"TruckValues.CurrentValues.PositionValue.X"),
            ["longitude"] = NullableNum(d,"TruckValues.CurrentValues.PositionValue.Z"), ["onJob"] = BoolAny(d,"SpecialEventsValues.OnJob"), ["fineAmount"] = NumAny(d,"GamePlay.FinedEvent.Amount"),
            ["fineOffence"] = StrAny(d,"GamePlay.FinedEvent.Offence")
        };
        var body = JsonSerializer.Serialize(new { sessionCode, status="online", eventType, directEvent=direct, data });
        using var req = Authorized(HttpMethod.Post,"/api/tracker/telemetry"); req.Content = new StringContent(body,Encoding.UTF8,"application/json");
        using var res = await apiHttp.SendAsync(req); if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized) { ClearToken(); throw new Exception("Sterling session expired • sign in again"); }
        if (!res.IsSuccessStatusCode) throw new Exception($"Sterling API returned {(int)res.StatusCode}");
        FooterText.Text = direct ? $"Sterling recorded {eventType.Replace('-',' ')}" : "Live data streaming to Sterling"; ConnectionText.Text = "Tracking";
    }

    void UpdateUi(JsonElement d)
    {
        var speed = SpeedMps(d); SpeedText.Text = $"{speed * 2.2369362921:0} mph";
        var limit = FirstNum(d,"NavigationValues.SpeedLimit.Mph","NavigationValues.SpeedLimit.Value");
        if (limit > 0 && limit < 40) limit *= 2.2369362921; // SDK may expose m/s in Value depending on telemetry version.
        SpeedLimitText.Text = limit > 0 ? $"{limit:0} mph" : "—";
        var rpm = FirstNum(d,"TruckValues.CurrentValues.DashboardValues.RPM","TruckValues.CurrentValues.EngineRpm","TruckValues.CurrentValues.EngineRPM");
        RpmText.Text = rpm > 0 ? $"{rpm:0}" : "0";
        var fuel = NumAny(d,"TruckValues.CurrentValues.DashboardValues.FuelValue.Amount"); FuelText.Text = $"{fuel:0} L";
        DamageText.Text = $"{MaxDamage(d) * 100:0.0}%";
        var gear = FirstNum(d,"TruckValues.CurrentValues.DashboardValues.GearDashboards","TruckValues.CurrentValues.DashboardValues.Gear"); GearText.Text = gear == 0 ? "N" : gear.ToString("0");
        CruiseText.Text = BoolAny(d,"TruckValues.CurrentValues.CruiseControl") || BoolAny(d,"TruckValues.CurrentValues.DashboardValues.CruiseControl") ? "ON" : "OFF";
        var truck = (StrAny(d,"TruckValues.ConstantsValues.Brand") + " " + First(StrAny(d,"TruckValues.ConstantsValues.Name"),StrAny(d,"TruckValues.ConstantsValues.Model"))).Trim(); TruckText.Text = truck.Length > 0 ? truck : "No truck detected";
        var cargo = StrAny(d,"JobValues.CargoValues.Name"); CargoText.Text = string.IsNullOrWhiteSpace(cargo) ? "No active delivery" : cargo;
        var src = StrAny(d,"JobValues.CitySource"); var dst = StrAny(d,"JobValues.CityDestination"); RouteText.Text = $"{(src.Length > 0 ? src : "—")}  →  {(dst.Length > 0 ? dst : "—")}";
        var km = FirstNum(d,"NavigationValues.NavigationDistance","JobValues.PlannedDistanceKm"); DistanceText.Text = km > 0 ? $"{(km > 10000 ? km / 1000.0 : km) * 0.621371:0} mi" : "—";
        var income = NumAny(d,"JobValues.Income"); JobValueText.Text = income > 0 ? $"£{income:N0}" : "—"; DriverPayText.Text = income > 0 ? $"£{income * 0.35:N0}" : "—";
        JobStateText.Text = BoolAny(d,"SpecialEventsValues.OnJob") ? "IN PROGRESS" : "WAITING";
    }

    HttpRequestMessage Authorized(HttpMethod method,string path){var req=new HttpRequestMessage(method,ApiBase+path);if(!string.IsNullOrWhiteSpace(sessionToken))req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",sessionToken);return req;}
    static double SpeedMps(JsonElement d){var speed=NumAny(d,"TruckValues.CurrentValues.DashboardValues.Speed.Value");if(speed==0){var kph=NumAny(d,"TruckValues.CurrentValues.DashboardValues.Speed.Kph");if(kph!=0)speed=kph/3.6;}return speed;}
    static string ReadError(string json){try{using var d=JsonDocument.Parse(json);return d.RootElement.TryGetProperty("error",out var e)?e.GetString()??"Sterling login failed":"Sterling login failed";}catch{return "Sterling login failed";}}
    static string First(params string[] x)=>x.FirstOrDefault(v=>!string.IsNullOrWhiteSpace(v))??"";
    static JsonElement? At(JsonElement e,string path){foreach(var p in path.Split('.')){if(e.ValueKind==JsonValueKind.Array&&int.TryParse(p,out var i)){if(i<0||i>=e.GetArrayLength())return null;e=e[i];continue;}if(e.ValueKind!=JsonValueKind.Object||!e.TryGetProperty(p,out var n))return null;e=n;}return e;}
    static string StrAny(JsonElement e,string path){var x=At(e,path);return x is {ValueKind:JsonValueKind.String}?x.Value.GetString()??"":x.HasValue&&x.Value.ValueKind!=JsonValueKind.Null?x.Value.ToString():"";}
    static double NumAny(JsonElement e,string path){var x=At(e,path);if(!x.HasValue)return 0;if(x.Value.ValueKind==JsonValueKind.Number&&x.Value.TryGetDouble(out var n))return n;return double.TryParse(x.Value.ToString(),out n)?n:0;}
    static double FirstNum(JsonElement e,params string[] paths){foreach(var p in paths){var n=NumAny(e,p);if(n!=0)return n;}return 0;}
    static double? NullableNum(JsonElement e,string path){var x=At(e,path);return x.HasValue?NumAny(e,path):null;}
    static bool BoolAny(JsonElement e,string path){var x=At(e,path);if(!x.HasValue)return false;if(x.Value.ValueKind==JsonValueKind.True)return true;if(x.Value.ValueKind==JsonValueKind.False)return false;return bool.TryParse(x.Value.ToString(),out var b)&&b;}
    static double MaxDamage(JsonElement d)=>new[]{"TruckValues.CurrentValues.DamageValues.Body","TruckValues.CurrentValues.DamageValues.Chassis","TruckValues.CurrentValues.DamageValues.Engine","TruckValues.CurrentValues.DamageValues.Transmission","TruckValues.CurrentValues.DamageValues.Cabin","TruckValues.CurrentValues.DamageValues.WheelsAvg"}.Select(p=>NumAny(d,p)).DefaultIfEmpty(0).Max();
    class Settings{public string ProtectedToken{get;set;}="";public string TrackerKey{get;set;}="";}
}
