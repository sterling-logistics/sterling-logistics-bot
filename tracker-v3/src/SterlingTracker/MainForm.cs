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
    private readonly Button _applyPayout = Button("Apply / link ETS2 payout profile");

    private DriverProfile? _profile;
    private DateTime _lastHeartbeat = DateTime.MinValue;
    private DateTime _lastJobStatusCheck = DateTime.MinValue;
    private DateTime _lastPayoutCheck = DateTime.MinValue;
    private string _lastJobStatusKey = "";
    private int _sending;
    private int _payoutApplying;

    public MainForm()
    {
        _api = new SterlingApiClient(_state);
        Text = "Sterling Tracker 3.0.8";
        MinimumSize = new Size(920, 680);
        Size = new Size(1080, 790);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(7, 15, 27);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10f);

        var header = new Panel { Dock = DockStyle.Top, Height = 82, Padding = new Padding(22, 14, 22, 8) };
        var title = new Label { Text = "STERLING TRACKER 3.0.8", AutoSize = true, Font = new Font("Segoe UI Semibold", 22f, FontStyle.Bold), ForeColor = Color.FromArgb(76, 169, 255), Location = new Point(20, 14) };
        var subtitle = new Label { Text = "Discord-linked ETS2/TMP telemetry • automatic Sterling payouts", AutoSize = true, ForeColor = Color.FromArgb(174, 193, 214), Location = new Point(23, 52) };
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
        var connGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 8, Padding = new Padding(16, 42, 16, 12) };
        connGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 36)); connGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 64));
        AddRow(connGrid, 0, "Driver", _driver); AddRow(connGrid, 1, "Sterling API", _apiStatus); AddRow(connGrid, 2, "ETS2", _ets2Status); AddRow(connGrid, 3, "Driver stats", _stats);
        connGrid.Controls.Add(_signIn, 0, 4); connGrid.SetColumnSpan(_signIn, 2);
        connGrid.Controls.Add(_signOut, 0, 5); connGrid.SetColumnSpan(_signOut, 2);
        connGrid.Controls.Add(_installPlugin, 0, 6); connGrid.SetColumnSpan(_installPlugin, 2);
        connGrid.Controls.Add(_applyPayout, 0, 7); connGrid.SetColumnSpan(_applyPayout, 2);
        connection.Controls.Add(connGrid);

        var logCard = Card("ACTIVITY");
        var logHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14, 42, 14, 12) }; logHost.Controls.Add(_log); logCard.Controls.Add(logHost);
        body.Controls.Add(live, 0, 0); body.Controls.Add(connection, 1, 0); body.Controls.Add(logCard, 0, 1); body.SetColumnSpan(logCard, 2);

        Controls.Add(body); Controls.Add(header);

        _signIn.Click += async (_, _) => await SignInAsync();
        _signOut.Click += async (_, _) => await SignOutAsync();
        _installPlugin.Click += (_, _) => InstallPlugin();
        _applyPayout.Click += async (_, _) => await ApplyPayoutAsync();
        _telemetry.SnapshotChanged += s => Ui(() => UpdateSnapshot(s));
        _telemetry.StatusChanged += s => Ui(() => _ets2Status.Text = s);
        _telemetry.TrackerEvent += (type, snap) => _ = SendEventAsync(type, snap);

        _tray = new NotifyIcon { Text = "Sterling Tracker 3.0.8", Icon = SystemIcons.Application, Visible = true };
        _tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        Resize += (_, _) => { if (WindowState == FormWindowState.Minimized) { Hide(); _tray.ShowBalloonTip(1200, "Sterling Tracker", "Tracker is still running in the background.", ToolTipIcon.Info); } };
        FormClosed += async (_, _) => await ShutdownAsync();
        Shown += async (_, _) => await StartupAsync();
    }

    private async Task StartupAsync()
    {
        Log("Tracker 3.0.8 starting");
        Log("API: " + _state.ApiBase);
        if (!string.IsNullOrWhiteSpace(_state.PreferredEts2ProfileRoot)) Log("Linked ETS2 profile: " + _state.PreferredEts2ProfileRoot);
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
            TryAutoLinkSingleProfile();
        }
        catch (Exception ex) { Log("Login failed: " + ex.Message); MessageBox.Show(ex.Message, "Sterling Tracker login", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        finally { _signIn.Enabled = true; }
    }

    private async Task SignOutAsync()
    {
        await _api.LogoutAsync(_shutdown.Token);
        _profile = null; RenderProfile(); Log("Signed out");
    }

    private void TryAutoLinkSingleProfile()
    {
        if (!string.IsNullOrWhiteSpace(_state.PreferredEts2ProfileRoot) && Directory.Exists(_state.PreferredEts2ProfileRoot)) return;
        var roots = Ets2PayoutService.FindProfileRoots();
        if (roots.Count != 1) return;
        _state.PreferredEts2ProfileRoot = roots[0];
        LocalState.Save(_state);
        Log("Automatically linked ETS2/TMP profile: " + roots[0]);
    }

    private async Task ApplyPayoutAsync()
    {
        if (Interlocked.Exchange(ref _payoutApplying, 1) != 0) return;
        _applyPayout.Enabled = false;
        PendingPayout? payout = null;
        try
        {
            if (!_api.IsAuthenticated) throw new InvalidOperationException("Sign in with Discord first.");
            if (Ets2PayoutService.IsGameRunning()) throw new InvalidOperationException("Close ETS2 and TruckersMP completely before applying money to the save.");

            payout = await _api.GetPendingPayoutAsync(_shutdown.Token);
            if (payout is null)
            {
                MessageBox.Show("There is no pending Sterling payout. Your ETS2/TMP profile can still be linked now for future automatic payouts.", "Sterling payout", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }

            var selected = ResolveLinkedOrManualSave(true);
            if (selected is null) return;
            RememberProfile(selected);

            if (payout is null)
            {
                Log("ETS2/TMP profile linked for automatic future payouts");
                MessageBox.Show("Your ETS2/TMP profile is now linked. Future /withdraw payouts will be applied automatically after ETS2/TMP is closed.", "Sterling profile linked", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var result = Ets2PayoutService.ApplyToSave(payout.Amount, selected);
            await _api.CompletePayoutAsync(payout.Id, result.SavePath, _shutdown.Token);
            Log($"PAYOUT APPLIED: £{payout.Amount:N2} • ETS2 £{result.OldBalance:N0} -> £{result.NewBalance:N0}");
            Log("Backup: " + result.BackupPath);
            MessageBox.Show($"Success. ETS2 balance changed from £{result.OldBalance:N0} to £{result.NewBalance:N0}.\n\nThis profile is now remembered for future automatic payouts.", "Sterling payout applied", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            Log("Payout failed: " + ex.Message);
            if (payout is not null) await _api.FailPayoutAsync(payout.Id, ex.Message, CancellationToken.None);
            MessageBox.Show(ex.Message, "Sterling payout failed", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _applyPayout.Enabled = true;
            Interlocked.Exchange(ref _payoutApplying, 0);
        }
    }

    private string? ResolveLinkedOrManualSave(bool allowPicker)
    {
        var linked = Ets2PayoutService.FindLatestSaveInProfile(_state.PreferredEts2ProfileRoot);
        if (linked is not null)
        {
            Log("Using linked ETS2/TMP save: " + linked.FullName);
            return linked.FullName;
        }

        TryAutoLinkSingleProfile();
        linked = Ets2PayoutService.FindLatestSaveInProfile(_state.PreferredEts2ProfileRoot);
        if (linked is not null) return linked.FullName;
        if (!allowPicker) return null;

        var newest = Ets2PayoutService.FindSaves().FirstOrDefault();
        var fallbackDirectory = newest?.DirectoryName ?? Ets2PayoutService.GetEts2Root();
        if (!Directory.Exists(fallbackDirectory)) fallbackDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        using var picker = new OpenFileDialog
        {
            Title = "Select your ETS2/TMP game.sii once - Sterling will remember the profile",
            Filter = "ETS2 save (game.sii)|game.sii|All files (*.*)|*.*",
            CheckFileExists = true,
            Multiselect = false,
            InitialDirectory = fallbackDirectory,
            FileName = "game.sii",
            RestoreDirectory = true
        };
        return picker.ShowDialog(this) == DialogResult.OK ? picker.FileName : null;
    }

    private void RememberProfile(string savePath)
    {
        var root = Ets2PayoutService.GetProfileRootForSave(savePath);
        if (string.IsNullOrWhiteSpace(root)) throw new InvalidOperationException("Sterling could not identify the ETS2 profile folder for that save.");
        if (string.Equals(root, _state.PreferredEts2ProfileRoot, StringComparison.OrdinalIgnoreCase)) return;
        _state.PreferredEts2ProfileRoot = root;
        LocalState.Save(_state);
        Log("Linked ETS2/TMP profile: " + root);
    }

    private async Task TryAutomaticPayoutAsync(CancellationToken ct)
    {
        if (Ets2PayoutService.IsGameRunning()) return;
        if (string.IsNullOrWhiteSpace(_state.PreferredEts2ProfileRoot)) { TryAutoLinkSingleProfile(); return; }
        if (Interlocked.Exchange(ref _payoutApplying, 1) != 0) return;
        try
        {
            var payout = await _api.GetPendingPayoutAsync(ct);
            if (payout is null) return;
            var save = Ets2PayoutService.FindLatestSaveInProfile(_state.PreferredEts2ProfileRoot);
            if (save is null)
            {
                Log("Automatic payout waiting: linked ETS2 profile has no game.sii yet");
                return;
            }
            var result = Ets2PayoutService.ApplyToSave(payout.Amount, save.FullName);
            await _api.CompletePayoutAsync(payout.Id, result.SavePath, ct);
            Log($"AUTO PAYOUT APPLIED: £{payout.Amount:N2} • ETS2 £{result.OldBalance:N0} -> £{result.NewBalance:N0}");
            Ui(() => _tray.ShowBalloonTip(3500, "Sterling payout applied", $"£{payout.Amount:N2} added to ETS2/TMP. New balance £{result.NewBalance:N0}.", ToolTipIcon.Info));
        }
        catch (UnauthorizedAccessException) { throw; }
        catch (Exception ex) { Log("Automatic payout waiting: " + ex.Message); }
        finally { Interlocked.Exchange(ref _payoutApplying, 0); }
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(ct))
        {
            if (!_api.IsAuthenticated) continue;

            if ((DateTime.UtcNow - _lastJobStatusCheck) >= TimeSpan.FromSeconds(5))
            {
                _lastJobStatusCheck = DateTime.UtcNow;
                try { await RefreshLatestJobStatusAsync(ct); }
                catch (UnauthorizedAccessException) { Ui(() => { _state.AccessToken = null; LocalState.Save(_state); _profile = null; RenderProfile(); _apiStatus.Text = "Login expired"; }); continue; }
                catch { }
            }

            if ((DateTime.UtcNow - _lastPayoutCheck) >= TimeSpan.FromSeconds(10))
            {
                _lastPayoutCheck = DateTime.UtcNow;
                try { await TryAutomaticPayoutAsync(ct); }
                catch (UnauthorizedAccessException) { Ui(() => { _state.AccessToken = null; LocalState.Save(_state); _profile = null; RenderProfile(); _apiStatus.Text = "Login expired"; }); continue; }
            }

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

    private async Task RefreshLatestJobStatusAsync(CancellationToken ct)
    {
        var latest = await _api.GetLatestJobStatusAsync(ct);
        if (latest is null) return;
        var key = latest.Value.JobCode + "|" + latest.Value.Status;
        if (key == _lastJobStatusKey) return;
        _lastJobStatusKey = key;

        var display = latest.Value.Status.ToLowerInvariant() switch
        {
            "completed" => "APPROVED",
            "rejected" => "DECLINED",
            "pending_review" => "PENDING REVIEW",
            "in_progress" => "IN PROGRESS",
            var s => s.Replace('_', ' ').ToUpperInvariant()
        };
        Ui(() =>
        {
            _jobStatus.Text = $"{display} • {latest.Value.JobCode}";
            Log($"Job {latest.Value.JobCode} is now {display.ToLowerInvariant()}");
        });

        if (latest.Value.Status.Equals("completed", StringComparison.OrdinalIgnoreCase))
        {
            try { _profile = await _api.GetProfileAsync(ct); Ui(RenderProfile); }
            catch { }
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
        _applyPayout.Visible = _profile is not null;
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
