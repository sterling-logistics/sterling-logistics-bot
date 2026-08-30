using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace SterlingTracker;

internal sealed record DispatchDriver(long Id, string SterlingDriverId, string DiscordUsername, string Rank, string Department)
{
    public override string ToString() => $"{SterlingDriverId} — {DiscordUsername}";
}

internal sealed record DispatchAssignment(
    string WorkCode,
    string Driver,
    string Cargo,
    string Origin,
    string Destination,
    string Status,
    double MinMiles,
    string Deadline,
    bool TrackerVerified,
    double ActualMiles,
    double Damage,
    string Notes);

internal sealed class DispatchApiClient : IDisposable
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(12) };
    private static string Base => TrackerState.PrimaryApiBase.TrimEnd('/');

    private HttpRequestMessage Request(HttpMethod method, string path)
    {
        var state = LocalState.Load();
        if (string.IsNullOrWhiteSpace(state.AccessToken)) throw new UnauthorizedAccessException("Sign in on the Tracker tab first.");
        var req = new HttpRequestMessage(method, Base + path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", state.AccessToken);
        return req;
    }

    private static async Task<string> BodyAsync(HttpResponseMessage res, CancellationToken ct)
    {
        var body = await res.Content.ReadAsStringAsync(ct);
        if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException("Your Sterling login has expired. Sign in again on the Tracker tab.");
        if (res.StatusCode == System.Net.HttpStatusCode.Forbidden) throw new UnauthorizedAccessException("This Sterling profile is not authorised for Dispatch Staff Edition.");
        if (!res.IsSuccessStatusCode)
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("error", out var e)) throw new InvalidOperationException(e.GetString() ?? body);
            }
            catch (JsonException) { }
            throw new InvalidOperationException($"Sterling Dispatch API returned {(int)res.StatusCode}: {body}");
        }
        return body;
    }

    public async Task<bool> IsStaffAsync(CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Get, "/api/dispatch/me");
        using var res = await _http.SendAsync(req, ct);
        using var doc = JsonDocument.Parse(await BodyAsync(res, ct));
        return doc.RootElement.TryGetProperty("isStaff", out var s) && s.GetBoolean();
    }

    public async Task<List<DispatchDriver>> GetDriversAsync(CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Get, "/api/dispatch/drivers");
        using var res = await _http.SendAsync(req, ct);
        using var doc = JsonDocument.Parse(await BodyAsync(res, ct));
        var list = new List<DispatchDriver>();
        foreach (var d in doc.RootElement.GetProperty("drivers").EnumerateArray())
        {
            list.Add(new DispatchDriver(
                d.GetProperty("id").GetInt64(),
                d.TryGetProperty("sterling_driver_id", out var id) ? id.GetString() ?? "Unknown" : "Unknown",
                d.TryGetProperty("discord_username", out var u) ? u.GetString() ?? "Unknown" : "Unknown",
                d.TryGetProperty("rank_name", out var r) ? r.GetString() ?? "Driver" : "Driver",
                d.TryGetProperty("department", out var dep) && dep.ValueKind != JsonValueKind.Null ? dep.GetString() ?? "" : ""));
        }
        return list;
    }

    public async Task<List<DispatchAssignment>> GetAssignmentsAsync(string status = "active", CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Get, "/api/dispatch/assignments?status=" + Uri.EscapeDataString(status));
        using var res = await _http.SendAsync(req, ct);
        using var doc = JsonDocument.Parse(await BodyAsync(res, ct));
        var list = new List<DispatchAssignment>();
        foreach (var w in doc.RootElement.GetProperty("assignments").EnumerateArray())
        {
            static string Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? v.ToString() : "";
            static double Num(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
            list.Add(new DispatchAssignment(
                Text(w,"work_code"),
                $"{Text(w,"sterling_driver_id")} — {Text(w,"discord_username")}",
                Text(w,"cargo"),Text(w,"origin_city"),Text(w,"destination_city"),Text(w,"status"),Num(w,"min_miles"),Text(w,"deadline_at"),
                w.TryGetProperty("tracker_verified", out var tv) && ((tv.ValueKind == JsonValueKind.Number && tv.GetInt32() != 0) || (tv.ValueKind == JsonValueKind.True)),
                Num(w,"actual_distance_miles"),Num(w,"actual_damage"),Text(w,"notes")));
        }
        return list;
    }

    public async Task<string> CreateAssignmentAsync(long driverId, string cargo, string origin, string destination, double minMiles, DateTime? deadline, string notes, CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Post, "/api/dispatch/assignments");
        req.Content = JsonContent.Create(new { driverId, cargo, origin, destination, minMiles, deadline = deadline?.ToString("O"), notes });
        using var res = await _http.SendAsync(req, ct);
        using var doc = JsonDocument.Parse(await BodyAsync(res, ct));
        return doc.RootElement.GetProperty("workCode").GetString() ?? "Created";
    }

    public async Task CancelAsync(string code, string reason, CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Post, $"/api/dispatch/assignments/{Uri.EscapeDataString(code)}/cancel");
        req.Content = JsonContent.Create(new { reason });
        using var res = await _http.SendAsync(req, ct);
        _ = await BodyAsync(res, ct);
    }

    public async Task ReassignAsync(string code, long driverId, CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Post, $"/api/dispatch/assignments/{Uri.EscapeDataString(code)}/reassign");
        req.Content = JsonContent.Create(new { driverId });
        using var res = await _http.SendAsync(req, ct);
        _ = await BodyAsync(res, ct);
    }

    public void Dispose() => _http.Dispose();
}
