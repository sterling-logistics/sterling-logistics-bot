using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace SterlingTracker;

internal sealed class SterlingApiClient : IDisposable
{
    private readonly TrackerState _state;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(10) };

    public SterlingApiClient(TrackerState state) => _state = state;
    public bool IsAuthenticated => !string.IsNullOrWhiteSpace(_state.AccessToken);
    public string ApiBase => _state.ApiBase;

    private HttpRequestMessage Request(HttpMethod method, string path)
    {
        var req = new HttpRequestMessage(method, _state.ApiBase.TrimEnd('/') + path);
        if (IsAuthenticated) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _state.AccessToken);
        return req;
    }

    private async Task<string> ResolveApiAsync(Action<string>? status = null, CancellationToken ct = default)
    {
        var candidates = new[]
        {
            _state.ApiBase,
            TrackerState.PrimaryApiBase,
            "http://45.43.163.175:3000",
            "http://45.43.163.175:8101"
        }
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Select(x => x.TrimEnd('/'))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        var failures = new List<string>();
        foreach (var candidate in candidates)
        {
            ct.ThrowIfCancellationRequested();
            status?.Invoke($"Connecting to {candidate}…");
            try
            {
                using var probeCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                probeCts.CancelAfter(TimeSpan.FromSeconds(4));
                using var res = await _http.GetAsync(candidate + "/health", probeCts.Token);
                if (!res.IsSuccessStatusCode)
                {
                    failures.Add($"{candidate} returned {(int)res.StatusCode}");
                    continue;
                }

                using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(probeCts.Token));
                if (!doc.RootElement.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
                {
                    failures.Add($"{candidate} returned an unhealthy response");
                    continue;
                }

                if (!string.Equals(_state.ApiBase, candidate, StringComparison.OrdinalIgnoreCase))
                {
                    _state.ApiBase = candidate;
                    LocalState.Save(_state);
                }
                status?.Invoke($"Sterling API connected • {candidate}");
                return candidate;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                failures.Add($"{candidate} timed out");
            }
            catch (Exception ex)
            {
                failures.Add($"{candidate}: {ex.Message}");
            }
        }

        throw new HttpRequestException("Sterling API is unreachable. " + string.Join(" | ", failures));
    }

    public async Task<bool> CheckHealthAsync(CancellationToken ct = default)
    {
        try { await ResolveApiAsync(null, ct); return true; }
        catch { return false; }
    }

    public async Task<DriverProfile?> GetProfileAsync(CancellationToken ct = default)
    {
        if (!IsAuthenticated) return null;
        using var req = Request(HttpMethod.Get, "/api/desktop/me");
        using var res = await _http.SendAsync(req, ct);
        if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized) return null;
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        var d = doc.RootElement.GetProperty("driver");
        return new DriverProfile
        {
            SterlingDriverId = d.TryGetProperty("sterlingDriverId", out var id) ? id.GetString() ?? "" : "",
            DiscordUsername = d.TryGetProperty("discordUsername", out var u) ? u.GetString() ?? "" : "",
            Rank = d.TryGetProperty("rank", out var r) && r.ValueKind != JsonValueKind.Null ? r.GetString() : null,
            TotalMiles = d.TryGetProperty("totalMiles", out var m) ? m.GetDouble() : 0,
            JobsCompleted = d.TryGetProperty("jobsCompleted", out var j) ? j.GetInt32() : 0
        };
    }

    public async Task<DriverProfile> SignInAsync(Action<string>? status = null, CancellationToken ct = default)
    {
        await ResolveApiAsync(status, ct);
        status?.Invoke("Starting Discord login…");
        using var start = new HttpRequestMessage(HttpMethod.Post, _state.ApiBase.TrimEnd('/') + "/auth/desktop/start")
        {
            Content = JsonContent.Create(new { deviceName = $"Sterling Tracker 3.0 • {Environment.MachineName}" })
        };
        using var startRes = await _http.SendAsync(start, ct);
        var startBody = await startRes.Content.ReadAsStringAsync(ct);
        if (!startRes.IsSuccessStatusCode) throw new InvalidOperationException($"Sterling login service returned {(int)startRes.StatusCode}: {startBody}");
        using var startDoc = JsonDocument.Parse(startBody);
        var root = startDoc.RootElement;
        var state = root.GetProperty("state").GetString() ?? throw new InvalidOperationException("Login state missing");
        var authorizeUrl = root.GetProperty("authorizeUrl").GetString() ?? throw new InvalidOperationException("Discord login URL missing");
        Process.Start(new ProcessStartInfo(authorizeUrl) { UseShellExecute = true });
        status?.Invoke("Complete login in your browser…");

        for (var i = 0; i < 300; i++)
        {
            ct.ThrowIfCancellationRequested();
            await Task.Delay(2000, ct);
            using var res = await _http.GetAsync(_state.ApiBase.TrimEnd('/') + "/auth/desktop/status?state=" + Uri.EscapeDataString(state), ct);
            var json = await res.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            var loginStatus = r.TryGetProperty("status", out var s) ? s.GetString() : null;
            if (loginStatus == "pending") continue;
            if (loginStatus != "complete") throw new InvalidOperationException(r.TryGetProperty("error", out var e) ? e.GetString() : "Discord login failed");
            _state.AccessToken = r.GetProperty("token").GetString();
            LocalState.Save(_state);
            var profile = await GetProfileAsync(ct) ?? throw new InvalidOperationException("Sterling driver profile could not be loaded");
            status?.Invoke($"Signed in as {profile.SterlingDriverId}");
            return profile;
        }
        throw new TimeoutException("Discord login timed out");
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        if (IsAuthenticated)
        {
            try { using var req = Request(HttpMethod.Post, "/auth/desktop/logout"); using var _ = await _http.SendAsync(req, ct); } catch { }
        }
        _state.AccessToken = null;
        LocalState.Save(_state);
    }

    public async Task<JsonDocument?> SendTelemetryAsync(string eventType, TelemetrySnapshot snapshot, bool directEvent = false, string status = "online", CancellationToken ct = default)
    {
        if (!IsAuthenticated) return null;
        var payload = new
        {
            sessionCode = _state.SessionCode,
            status,
            eventType,
            directEvent,
            data = snapshot.ToApiData()
        };
        using var req = Request(HttpMethod.Post, "/api/tracker/telemetry");
        req.Content = JsonContent.Create(payload);
        using var res = await _http.SendAsync(req, ct);
        if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException("Sterling Tracker login has expired");
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"Sterling API {res.StatusCode}: {body}");
        return JsonDocument.Parse(body);
    }

    public void Dispose() => _http.Dispose();
}
