using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Sterling.Logistics.ControlCentre.Services;

public sealed class ControlCentreApiClient
{
    private readonly HttpClient _http = new();
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);
    private string? _accessToken;

    public ControlCentreApiClient()
    {
        var configured = Environment.GetEnvironmentVariable("STERLING_API_URL");
        _http.BaseAddress = new Uri(string.IsNullOrWhiteSpace(configured)
            ? "https://sterlinglogisticsvtc.co.uk/"
            : configured.TrimEnd('/') + "/");
        _http.Timeout = TimeSpan.FromSeconds(15);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("SterlingControlCentre/2.0");
    }

    public SterlingOwner? CurrentOwner { get; private set; }

    public async Task LoginOwnerAsync(string username, string password, CancellationToken cancellationToken = default)
    {
        using var response = await _http.PostAsJsonAsync("api/v2/auth/login", new { username, password }, _json, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException("Sign in failed. Check your Sterling credentials.");

        var login = await response.Content.ReadFromJsonAsync<LoginResponse>(_json, cancellationToken)
                    ?? throw new InvalidOperationException("Invalid server response.");
        if (!string.Equals(login.User.Role, "owner", StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Sterling Control Centre is restricted to the Owner/Founder account.");

        _accessToken = login.AccessToken;
        CurrentOwner = login.User;
    }

    public async Task<LiveSummary> GetSummaryAsync(CancellationToken cancellationToken = default)
        => await GetAsync<LiveSummary>("api/v2/owner/live/summary", cancellationToken);

    public async Task<IReadOnlyList<LiveDriver>> GetLiveDriversAsync(CancellationToken cancellationToken = default)
    {
        var envelope = await GetAsync<DriverEnvelope>("api/v2/owner/live/drivers", cancellationToken);
        return envelope.Drivers;
    }

    public async Task<IReadOnlyList<OwnerJob>> GetJobsAsync(CancellationToken cancellationToken = default)
    {
        var envelope = await GetAsync<JobEnvelope>("api/v2/owner/jobs", cancellationToken);
        return envelope.Jobs;
    }

    private async Task<T> GetAsync<T>(string path, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_accessToken)) throw new InvalidOperationException("Not signed in.");
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
        using var response = await _http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Sterling API request failed ({(int)response.StatusCode}).");
        return await response.Content.ReadFromJsonAsync<T>(_json, cancellationToken)
               ?? throw new InvalidOperationException("Invalid Sterling API response.");
    }
}

public sealed record LoginResponse(string AccessToken, string RefreshToken, SterlingOwner User);
public sealed record SterlingOwner(long Id, string Username, string DisplayName, string Role, string RankName);
public sealed record LiveSummary(long ActiveDrivers, long OnlineDrivers, long OnJob, long JobsInProgress, long PendingApprovals, long PendingPayouts, long FailedPayouts);
public sealed record LiveDriver(long Id, string Username, string DisplayName, string Role, string RankName, string? TrackerVersion, string? Game, bool GameRunning, bool OnJob, string? Status, DateTime? LastSeenAt, bool IsOnline, decimal? Latitude, decimal? Longitude, decimal? HeadingDeg, decimal? SpeedKph, string? City, string? TruckMake, string? TruckModel, string? Cargo, string? OriginCity, string? DestinationCity, decimal? FuelPercent, decimal? DamagePercent, decimal? FinesTotal);
public sealed record DriverEnvelope(IReadOnlyList<LiveDriver> Drivers);
public sealed record OwnerJob(Guid Id, string Status, string Game, string Cargo, string OriginCity, string DestinationCity, decimal? DistanceKm, decimal PayoutAmount, DateTime? SubmittedAt, DateTime? ApprovedAt, DateTime? PaidAt, DateTime CreatedAt, long DriverUserId, string Username, string DriverDisplayName, string DriverRole);
public sealed record JobEnvelope(IReadOnlyList<OwnerJob> Jobs);
