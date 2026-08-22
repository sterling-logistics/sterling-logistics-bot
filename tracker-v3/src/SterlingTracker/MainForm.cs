using System.Diagnostics;
using System.Text.Json;

namespace SterlingTracker;

internal sealed class MainForm : Form
{
    private readonly TrackerState _state = LocalState.Load();
    private readonly SterlingApiClient _api;
    private readonly TelemetryService _telemetry = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly NotifyIcon _tray;

    private readonly Label _driver = ValueLabel();
    private readonly Label _apiStatus = ValueLabel();
    private readonly Label _ets2Status = ValueLabel();
    private readonly Label _jobStatus = ValueLabel();
    private readonly Label _speed = BigValue();
    private readonly Label _truck = ValueLabel();
    private readonly Label _cargo = ValueLabel();
    private readonly Label _route = ValueLabel();
    private readonly Label _fuel = ValueLabel();
    private readonly Label _damage = ValueLabel();
    private readonly Label _stats = ValueLabel();
    private readonly TextBox _log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BackColor = Color.FromArgb(9, 18, 31), ForeColor = Color.Gainsboro, BorderStyle = BorderStyle.FixedSingle };
    private readonly Button _signIn = Button("Sign in with Discord");
    private readonly Button _signOut = Button("Sign out");
    private readonly Button _installPlugin = Button("Install ETS2 telemetry");

    private DriverProfile? _profile;
    private DateTime _lastHeartbeat = DateTime.MinValue;
    private int _sending;

    public MainForm()
    {
        _api = new SterlingApiClient(_state);
        Text = "Sterling Tracker 3.0";
        MinimumSize = new Size(920, 650);
        Size = new Size(1080, 760);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(7, 15, 27);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10f);

        var header = new Panel { Dock = DockStyle.Top, Height = 82, Padding = new Padding(22, 14, 22, 8) };
        var title = new Label { Text = "STERLING TRACKER 3.0", AutoSize = true, Font = new Font("Segoe UI Semibold", 22f, FontStyle.Bold), ForeColor = Color.FromArgb(76, 169, 255), Location = new Point(20, 14) };
        var subtitle = new Label { Text = "Direct ETS2 telemetry • Sterling Logistics live operations", AutoSize = true, ForeColor = Color.FromArgb(174, 193, 214), Location = new Point(23, 52) };
        header.Controls.Add(title); header.Controls.Add(subtitle);

        var body = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), ColumnCount = 2, RowCount = 2 };
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58));
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42));
        body.RowStyles.Add(new RowStyle(SizeType.Percent, 66));
        body.RowStyles.Add(new RowStyle(SizeType.Percent, 34));

        var live = Card("LIVE TELEMETRY");
        var liveGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 7, Padding = new Padding(16, 42, 16, 12) };
        liveGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34)); liveGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 66));
        AddRow(liveGrid, 0, "Speed", _speed); AddRow(liveGrid, 1, "Truck", _truck); AddRow(liveGrid, 2, "Cargo", _cargo); AddRow(liveGrid, 3, "Route", _route); AddRow(liveGrid, 4, "Fuel", _fuel); AddRow(liveGrid, 5, "Damage", _damage); AddRow(liveGrid, 6, "Job", _jobStatus);
        live.Controls.Add(liveGrid);

        var connection = Card("CONNECTION");
        var connGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 7, Padding = new Padding(16, 42, 16, 12) };
        connGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 36)); connGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 64));
        AddRow(connGrid, 0, "Driver", _driver); AddRow(connGrid, 1, "Sterling API", _apiStatus); AddRow(connGrid, 2, "ETS2", _ets2Status); AddRow(connGrid, 3, "Driver stats", _stats);
        connGrid.Controls.Add(_signIn, 0, 4); connGrid.SetColumnSpan(_signIn, 2);
        connGrid.Controls.Add(_signOut, 0, 5); connGrid.SetColumnSpan(_signOut, 2);
        connGrid.Controls.Add(_installPlugin, 0, 6); connGrid.SetColumnSpan(_installPlugin, 2);
        connection.Controls.Add(connGrid);

        var logCard = Card("ACTIVITY");
        var logHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14, 42, 14, 12) }; logHost.Controls.Add(_log); logCard.Controls.Add(logHost);
        body.Controls.Add(live, 0, 0); body.Controls.Add(connection, 1, 0); body.Controls.Add(logCard, 0, 1); body.SetColumnSpan(logCard, 2);

        Controls.Add(body); Controls.Add(header);

        _signIn.Click += async (_, _) => await SignInAsync();
        _signOut.Click += async (_, _) => await SignOutAsync();
        _installPlugin.Click += (_, _) => InstallPlugin();
        _telemetry.SnapshotChanged += s => Ui(() => UpdateSnapshot(s));
        _telemetry.StatusChanged += s => Ui(() => _ets2Status.Text = s);
        _telemetry.TrackerEvent += (type, snap) => _ = SendEventAsync(type, snap);

        _tray = new NotifyIcon { Text = "Sterling Tracker 3.0", Icon = SystemIcons.Application, Visible = true };
        _tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        Resize += (_, _) => { if (WindowState == FormWindowState.Minimized) { Hide(); _tray.ShowBalloonTip(1200, "Sterling Tracker", "Tracker is still running in the background.", ToolTipIcon.Info); } };
        FormClosed += async (_, _) => await ShutdownAsync();
        Shown += async (_, _) => await StartupAsync();
    }

    private async Task StartupAsync()
    {
        Log("Tracker 3.0 starting");
        Log("API: " + _state.ApiBase);
        _telemetry.Start();
        _ = HeartbeatLoopAsync(_shutdown.Token);
        var healthy = await _api.CheckHealthAsync(_shutdown.Token);
        _apiStatus.Text = healthy ? "Online" : "Unavailable";
        if (!healthy) Log("Sterling API is not reachable yet");
        if (_api.IsAuthenticated)
        {
            try { _profile = await _api.GetProfileAsync(_shutdown.Token); }
            catch (Exception ex) { Log("Saved login check failed: " + ex.Message); }
        }
        RenderProfile();
    }

    private async Task SignInAsync()
    {
        _signIn.Enabled = false;
        try
        {
            _profile = await _api.SignInAsync(s => Ui(() => { _apiStatus.Text = s; Log(s); }), _shutdown.Token);
            _apiStatus.Text = "Connected";
            RenderProfile();
        }
        catch (Exception ex) { Log("Login failed: " + ex.Message); MessageBox.Show(ex.Message, "Sterling Tracker login", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        finally { _signIn.Enabled = true; }
    }

    private async Task SignOutAsync()
    {
        await _api.LogoutAsync(_shutdown.Token);
        _profile = null; RenderProfile(); Log("Signed out");
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(ct))
        {
            if (!_api.IsAuthenticated) continue;
            if (!_telemetry.Connected)
            {
                _telemetry.Start();
                continue;
            }
            if (Interlocked.Exchange(ref _sending, 1) != 0) continue;
            try
            {
                await _api.SendTelemetryAsync("heartbeat", _telemetry.Latest, false, "online", ct);
                _lastHeartbeat = DateTime.Now;
                Ui(() => _apiStatus.Text = "Live • " + _lastHeartbeat.ToString("HH:mm:ss"));
            }
            catch (UnauthorizedAccessException) { Ui(() => { _state.AccessToken = null; LocalState.Save(_state); _profile = null; RenderProfile(); _apiStatus.Text = "Login expired"; }); }
            catch (Exception ex) { Ui(() => { _apiStatus.Text = "Retrying"; Log("Heartbeat: " + ex.Message); }); }
            finally { Interlocked.Exchange(ref _sending, 0); }
        }
    }

    private async Task SendEventAsync(string type, TelemetrySnapshot snapshot)
    {
        if (!_api.IsAuthenticated) { Ui(() => Log($"ETS2 event {type} detected; sign in to submit it")); return; }
        try
        {
            using var response = await _api.SendTelemetryAsync(type, snapshot, true, "online", _shutdown.Token);
            var extra = "";
            if (response is not null && response.RootElement.TryGetProperty("persistedJob", out var p) && p.ValueKind == JsonValueKind.Object)
            {
                if (p.TryGetProperty("jobCode", out var code)) extra = " • " + code.GetString();
                if (p.TryGetProperty("status", out var status)) extra += " • " + status.GetString();
            }
            Ui(() => { Log($"Submitted {type}{extra}"); _jobStatus.Text = type.Replace("job-", "", StringComparison.OrdinalIgnoreCase) + extra; });
        }
        catch (Exception ex) { Ui(() => Log($"Could not submit {type}: {ex.Message}")); }
    }

    private async Task ShutdownAsync()
    {
        if (_shutdown.IsCancellationRequested) return;
        try { if (_api.IsAuthenticated) await _api.SendTelemetryAsync("heartbeat", _telemetry.Latest, false, "offline", CancellationToken.None); } catch { }
        _shutdown.Cancel(); _telemetry.Dispose(); _api.Dispose(); _tray.Visible = false; _tray.Dispose();
    }

    private void InstallPlugin()
    {
        var script = Path.Combine(AppContext.BaseDirectory, "Telemetry", "install-telemetry.ps1");
        var plugin = Path.Combine(AppContext.BaseDirectory, "Telemetry", "scs-telemetry.dll");
        if (!File.Exists(script) || !File.Exists(plugin)) { MessageBox.Show("Telemetry installation files are missing. Reinstall Sterling Tracker.", "Sterling Tracker", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        try
        {
            Process.Start(new ProcessStartInfo("powershell.exe", $"-NoProfile -ExecutionPolicy Bypass -File \"{script}\" -PluginSource \"{plugin}\"") { UseShellExecute = true, Verb = "runas" });
            Log("Telemetry installer started");
        }
        catch (Exception ex) { Log("Telemetry installer: " + ex.Message); }
    }

    private void UpdateSnapshot(TelemetrySnapshot s)
    {
        _speed.Text = $"{s.SpeedMps * 2.2369362921:0} mph";
        _truck.Text = string.IsNullOrWhiteSpace(s.Truck) ? "—" : s.Truck;
        _cargo.Text = string.IsNullOrWhiteSpace(s.Cargo) ? "No active cargo" : s.Cargo;
        _route.Text = string.IsNullOrWhiteSpace(s.SourceCity + s.DestinationCity) ? "—" : $"{s.SourceCity} → {s.DestinationCity}";
        _fuel.Text = s.FuelCapacityLiters > 0 ? $"{s.FuelLiters:0.0} / {s.FuelCapacityLiters:0.0} L" : $"{s.FuelLiters:0.0} L";
        _damage.Text = $"Truck {s.TruckDamage * 100:0.0}% • Trailer {s.TrailerDamage * 100:0.0}% • Cargo {s.CargoDamage * 100:0.0}%";
        if (s.OnJob && !_jobStatus.Text.Contains("pending", StringComparison.OrdinalIgnoreCase)) _jobStatus.Text = $"Driving • {s.PlannedDistanceKm:0} km planned";
    }

    private void RenderProfile()
    {
        _driver.Text = _profile is null ? "Not signed in" : $"{_profile.SterlingDriverId} • {_profile.DiscordUsername}";
        _stats.Text = _profile is null ? "—" : $"{_profile.TotalMiles:N0} miles • {_profile.JobsCompleted:N0} jobs • {_profile.Rank ?? "Driver"}";
        _signIn.Visible = _profile is null; _signOut.Visible = _profile is not null;
    }

    private void Log(string text)
    {
        if (InvokeRequired) { BeginInvoke(new Action(() => Log(text))); return; }
        _log.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}");
    }

    private void Ui(Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        if (InvokeRequired) BeginInvoke(action); else action();
    }

    private static Panel Card(string title)
    {
        var p = new Panel { Dock = DockStyle.Fill, Margin = new Padding(8), BackColor = Color.FromArgb(15, 28, 46) };
        p.Controls.Add(new Label { Text = title, AutoSize = true, Font = new Font("Segoe UI Semibold", 11f, FontStyle.Bold), ForeColor = Color.FromArgb(76, 169, 255), Location = new Point(16, 14) });
        return p;
    }

    private static void AddRow(TableLayoutPanel grid, int row, string name, Control value)
    {
        grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100f / Math.Max(1, grid.RowCount)));
        grid.Controls.Add(new Label { Text = name, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.FromArgb(154, 177, 202) }, 0, row);
        value.Dock = DockStyle.Fill;
        if (value is Label label) label.TextAlign = ContentAlignment.MiddleLeft;
        grid.Controls.Add(value, 1, row);
    }

    private static Label ValueLabel() => new() { Text = "—", AutoEllipsis = true, ForeColor = Color.White };
    private static Label BigValue() => new() { Text = "0 mph", AutoEllipsis = true, ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 20f, FontStyle.Bold) };
    private static Button Button(string text) => new() { Text = text, Dock = DockStyle.Fill, Margin = new Padding(2, 5, 2, 5), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(31, 92, 151), ForeColor = Color.White, FlatAppearance = { BorderSize = 0 } };
}
