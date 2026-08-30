using System.Net.Http;
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
        using var response = await SendAsync(HttpMethod.Post, "api/v2/tracker/heartbeat", accessToken, heartbeat, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Heartbeat rejected by Sterling server.", (int)response.StatusCode);
    }

    public async Task SendTelemetryEventAsync(string accessToken, TrackerTelemetryEvent telemetryEvent, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Post, "api/v2/tracker/events", accessToken, telemetryEvent, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Telemetry event rejected by Sterling server.", (int)response.StatusCode);
    }

    public async Task<IReadOnlyList<TrackerJob>> GetMyJobsAsync(string accessToken, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, "api/v2/jobs/mine", accessToken, null, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Could not load Sterling jobs.", (int)response.StatusCode);
        var envelope = await response.Content.ReadFromJsonAsync<JobEnvelope>(_json, cancellationToken);
        return envelope?.Jobs ?? [];
    }

    public async Task StartJobAsync(string accessToken, Guid jobId, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Post, $"api/v2/jobs/{jobId:D}/start", accessToken, new { }, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Could not start the Sterling job.", (int)response.StatusCode);
    }

    public async Task<JobSubmitResponse> SubmitJobAsync(string accessToken, Guid jobId, Guid clientSubmissionId, decimal distanceKm, decimal? revenueGame, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Post, $"api/v2/jobs/{jobId:D}/submit", accessToken,
            new { clientSubmissionId, distanceKm, revenueGame }, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Could not submit the Sterling job.", (int)response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JobSubmitResponse>(_json, cancellationToken)
               ?? new JobSubmitResponse(true, "submitted", false, false, null);
    }

    public async Task<PayoutClaim?> ClaimNextPayoutAsync(string accessToken, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Post, "api/v2/payouts/claim-next", accessToken, new { }, cancellationToken);
        if ((int)response.StatusCode == 204) return null;
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Could not claim Sterling payout.", (int)response.StatusCode);
        return await response.Content.ReadFromJsonAsync<PayoutClaim>(_json, cancellationToken);
    }

    public async Task CompletePayoutAsync(string accessToken, Guid payoutId, Guid leaseToken, Guid applicationId, decimal balanceBefore, decimal balanceAfter, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Post, $"api/v2/payouts/{payoutId:D}/complete", accessToken,
            new { leaseToken, applicationId, balanceBefore, balanceAfter }, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Sterling could not confirm the game payout.", (int)response.StatusCode);
    }

    public async Task FailPayoutAsync(string accessToken, Guid payoutId, Guid leaseToken, string error, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Post, $"api/v2/payouts/{payoutId:D}/fail", accessToken,
            new { leaseToken, error }, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new SterlingApiException("Sterling could not record the payout retry.", (int)response.StatusCode);
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string accessToken, object? body, CancellationToken cancellationToken)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        if (body is not null) request.Content = JsonContent.Create(body, options: _json);
        try
        {
            return await _http.SendAsync(request, cancellationToken);
        }
        finally
        {
            request.Dispose();
        }
    }
}

public sealed class SterlingApiException : Exception
{
    public int? StatusCode { get; }
    public SterlingApiException(string message, int? statusCode = null) : base(message) => StatusCode = statusCode;
}

public sealed record LoginResponse(string AccessToken, string RefreshToken, SterlingUser User);
public sealed record SterlingUser(long Id, string Username, string DisplayName, string Role, string RankName);
public sealed record TrackerHeartbeat(string TrackerVersion, string? Game, bool GameRunning, bool OnJob, string Status,
    double? Latitude = null, double? Longitude = null, double? WorldX = null, double? WorldY = null, double? WorldZ = null,
    double? HeadingDeg = null, double? SpeedKph = null, string? City = null, string? TruckMake = null,
    string? TruckModel = null, string? Cargo = null, string? OriginCity = null, string? DestinationCity = null,
    double? FuelPercent = null, double? DamagePercent = null, double? FinesTotal = null);
public sealed record TrackerTelemetryEvent(string EventType, string? Game, Guid? JobPublicId, IReadOnlyDictionary<string, object?>? Payload = null);
public sealed record TrackerJob(Guid Id, string Status, string Game, string Cargo, string OriginCity, string DestinationCity, decimal? DistanceKm, decimal PayoutAmount);
public sealed record JobEnvelope(IReadOnlyList<TrackerJob> Jobs);
public sealed record JobSubmitResponse(bool Ok, string Status, bool Duplicate, bool AutoApproved, Guid? PayoutId);
public sealed record PayoutClaim(Guid Id, Guid JobId, string Game, decimal Amount, string Currency, Guid LeaseToken, int LeaseSeconds);
