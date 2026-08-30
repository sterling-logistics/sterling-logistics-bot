using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Sterling.Logistics.Tracker.Services;

public sealed class SterlingApiClient
{
    private readonly HttpClient _http;
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);

    public SterlingApiClient(HttpClient? httpClient = null)
    {
        _http = httpClient ?? new HttpClient();
        var configured = Environment.GetEnvironmentVariable("STERLING_API_URL");
        _http.BaseAddress = new Uri(string.IsNullOrWhiteSpace(configured)
            ? "https://sterlinglogisticsvtc.co.uk/"
            : configured.TrimEnd('/') + "/");
        _http.Timeout = TimeSpan.FromSeconds(15);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("SterlingTachograph/2.0");
    }

    public async Task<LoginResponse> LoginAsync(string username, string password, CancellationToken cancellationToken = default)
    {
        using var response = await _http.PostAsJsonAsync("api/v2/auth/login", new { username, password }, _json, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Sign in failed. Check your Sterling username and password.", (int)response.StatusCode);

        return await response.Content.ReadFromJsonAsync<LoginResponse>(_json, cancellationToken)
               ?? throw new SterlingApiException("The Sterling server returned an invalid login response.");
    }

    public async Task<LoginResponse> RefreshAsync(string refreshToken, CancellationToken cancellationToken = default)
    {
        using var response = await _http.PostAsJsonAsync("api/v2/auth/refresh", new { refreshToken }, _json, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Your Sterling session has expired.", (int)response.StatusCode);
        return await response.Content.ReadFromJsonAsync<LoginResponse>(_json, cancellationToken)
               ?? throw new SterlingApiException("The Sterling server returned an invalid refresh response.");
    }

    public async Task SendHeartbeatAsync(string accessToken, TrackerHeartbeat heartbeat, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "api/v2/tracker/heartbeat")
        {
            Content = JsonContent.Create(heartbeat, options: _json)
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await _http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Heartbeat rejected by Sterling server.", (int)response.StatusCode);
    }

    public async Task<IReadOnlyList<TrackerJob>> GetMyJobsAsync(string accessToken, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "api/v2/jobs/mine");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await _http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Could not load Sterling jobs.", (int)response.StatusCode);
        var envelope = await response.Content.ReadFromJsonAsync<JobEnvelope>(_json, cancellationToken);
        return envelope?.Jobs ?? [];
    }
}

public sealed class SterlingApiException : Exception
{
    public int? StatusCode { get; }
    public SterlingApiException(string message, int? statusCode = null) : base(message) => StatusCode = statusCode;
}

public sealed record LoginResponse(string AccessToken, string RefreshToken, SterlingUser User);
public sealed record SterlingUser(long Id, string Username, string DisplayName, string Role, string RankName);
public sealed record TrackerHeartbeat(
    string TrackerVersion,
    string? Game,
    bool GameRunning,
    bool OnJob,
    string Status,
    double? Latitude = null,
    double? Longitude = null,
    double? HeadingDeg = null,
    double? SpeedKph = null,
    string? City = null,
    string? TruckMake = null,
    string? TruckModel = null,
    string? Cargo = null,
    string? OriginCity = null,
    string? DestinationCity = null,
    double? FuelPercent = null,
    double? DamagePercent = null,
    double? FinesTotal = null);
public sealed record TrackerJob(Guid Id, string Status, string Game, string Cargo, string OriginCity, string DestinationCity, decimal? DistanceKm, decimal PayoutAmount);
public sealed record JobEnvelope(IReadOnlyList<TrackerJob> Jobs);
