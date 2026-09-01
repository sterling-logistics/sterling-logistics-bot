using System.Net.Http;
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
    public bool IsOwnerSignedIn => CurrentOwner is not null && !string.IsNullOrWhiteSpace(_accessToken);

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

    public Task<LiveSummary> GetSummaryAsync(CancellationToken cancellationToken = default)
        => SendForJsonAsync<LiveSummary>(HttpMethod.Get, "api/v2/owner/live/summary", null, cancellationToken);

    public async Task<IReadOnlyList<LiveDriver>> GetLiveDriversAsync(CancellationToken cancellationToken = default)
        => (await SendForJsonAsync<DriverEnvelope>(HttpMethod.Get, "api/v2/owner/live/drivers", null, cancellationToken)).Drivers;

    public async Task<IReadOnlyList<OwnerDriver>> GetDriversAsync(CancellationToken cancellationToken = default)
        => (await SendForJsonAsync<OwnerDriverEnvelope>(HttpMethod.Get, "api/v2/owner/drivers", null, cancellationToken)).Drivers;

    public async Task<IReadOnlyList<OwnerJob>> GetJobsAsync(CancellationToken cancellationToken = default)
        => (await SendForJsonAsync<JobEnvelope>(HttpMethod.Get, "api/v2/owner/jobs", null, cancellationToken)).Jobs;

    public async Task<IReadOnlyList<PendingReviewJob>> GetPendingReviewAsync(CancellationToken cancellationToken = default)
        => (await SendForJsonAsync<PendingReviewEnvelope>(HttpMethod.Get, "api/v2/owner/jobs/pending-review", null, cancellationToken)).Jobs;

    public async Task<IReadOnlyList<OwnerPayout>> GetPayoutsAsync(CancellationToken cancellationToken = default)
        => (await SendForJsonAsync<PayoutEnvelope>(HttpMethod.Get, "api/v2/owner/payouts", null, cancellationToken)).Payouts;

    public async Task<IReadOnlyList<AuditEvent>> GetAuditAsync(CancellationToken cancellationToken = default)
        => (await SendForJsonAsync<AuditEnvelope>(HttpMethod.Get, "api/v2/owner/audit", null, cancellationToken)).Events;

    public Task<DriverHistoryEnvelope> GetDriverHistoryAsync(long driverId, CancellationToken cancellationToken = default)
        => SendForJsonAsync<DriverHistoryEnvelope>(HttpMethod.Get, $"api/v2/owner/drivers/{driverId}/history", null, cancellationToken);

    public Task<SystemHealth> GetSystemHealthAsync(CancellationToken cancellationToken = default)
        => SendForJsonAsync<SystemHealth>(HttpMethod.Get, "api/v2/owner/system", null, cancellationToken);

    public Task<CreateDriverResponse> CreateDriverAsync(string username, string password, string displayName, string rankName, CancellationToken cancellationToken = default)
        => SendForJsonAsync<CreateDriverResponse>(HttpMethod.Post, "api/v2/owner/drivers", new { username, password, displayName, rankName }, cancellationToken);

    public Task<OperationResponse> SetDriverPasswordAsync(long driverId, string password, CancellationToken cancellationToken = default)
        => SendForJsonAsync<OperationResponse>(HttpMethod.Post, $"api/v2/owner/drivers/{driverId}/set-password", new { password }, cancellationToken);

    public Task<OperationResponse> SetDriverActiveAsync(long driverId, bool isActive, CancellationToken cancellationToken = default)
        => SendForJsonAsync<OperationResponse>(HttpMethod.Patch, $"api/v2/owner/drivers/{driverId}/active", new { isActive }, cancellationToken);

    public Task<CreateJobResponse> CreateJobAsync(long driverUserId, string game, string cargo, string originCity, string destinationCity, decimal? distanceKm, decimal payoutAmount, CancellationToken cancellationToken = default)
        => SendForJsonAsync<CreateJobResponse>(HttpMethod.Post, "api/v2/owner/jobs", new { driverUserId, game, cargo, originCity, destinationCity, distanceKm, payoutAmount }, cancellationToken);

    public Task<OperationResponse> ApproveJobAsync(Guid jobId, string? notes = null, CancellationToken cancellationToken = default)
        => SendForJsonAsync<OperationResponse>(HttpMethod.Post, $"api/v2/owner/jobs/{jobId:D}/approve", new { notes }, cancellationToken);

    public Task<OperationResponse> DeclineJobAsync(Guid jobId, string? notes = null, CancellationToken cancellationToken = default)
        => SendForJsonAsync<OperationResponse>(HttpMethod.Post, $"api/v2/owner/jobs/{jobId:D}/decline", new { notes }, cancellationToken);

    private async Task<T> SendForJsonAsync<T>(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_accessToken)) throw new InvalidOperationException("Owner/Founder is not signed in.");
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
        if (body is not null) request.Content = JsonContent.Create(body, options: _json);
        using var response = await _http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            ApiError? apiError = null;
            try { apiError = await response.Content.ReadFromJsonAsync<ApiError>(_json, cancellationToken).ConfigureAwait(false); } catch { }
            throw new InvalidOperationException(apiError?.Error is { Length: > 0 }
                ? $"Sterling rejected the operation: {apiError.Error}"
                : $"Sterling API request failed ({(int)response.StatusCode}).");
        }
        return await response.Content.ReadFromJsonAsync<T>(_json, cancellationToken)
               ?? throw new InvalidOperationException("Invalid Sterling API response.");
    }
}

public sealed record ApiError(string Error);
public sealed record LoginResponse(string AccessToken, string RefreshToken, SterlingOwner User);
public sealed record SterlingOwner(long Id, string Username, string DisplayName, string Role, string RankName);
public sealed record LiveSummary(long ActiveDrivers, long OnlineDrivers, long OnJob, long JobsInProgress, long PendingApprovals, long PendingPayouts, long FailedPayouts);
public sealed record LiveDriver(long Id, string Username, string DisplayName, string Role, string RankName, string? TrackerVersion,
    string? Game, bool GameRunning, bool OnJob, string? Status, DateTime? LastSeenAt, bool IsOnline,
    decimal? Latitude, decimal? Longitude, decimal? WorldX, decimal? WorldY, decimal? WorldZ,
    decimal? HeadingDeg, decimal? SpeedKph, string? City, string? TruckMake, string? TruckModel, string? Cargo,
    string? OriginCity, string? DestinationCity, decimal? FuelPercent, decimal? DamagePercent, decimal? FinesTotal);
public sealed record DriverEnvelope(IReadOnlyList<LiveDriver> Drivers);
public sealed record OwnerDriver(long Id, string Username, string DisplayName, string Role, string RankName, bool IsActive, DateTime CreatedAt, DateTime UpdatedAt);
public sealed record OwnerDriverEnvelope(IReadOnlyList<OwnerDriver> Drivers);
public sealed record OwnerJob(Guid Id, string Status, string Game, string Cargo, string OriginCity, string DestinationCity, decimal? DistanceKm, decimal PayoutAmount, DateTime? SubmittedAt, DateTime? ApprovedAt, DateTime? PaidAt, DateTime CreatedAt, long DriverUserId, string Username, string DriverDisplayName, string DriverRole);
public sealed record JobEnvelope(IReadOnlyList<OwnerJob> Jobs);
public sealed record PendingReviewJob(Guid Id, string Game, string Cargo, string OriginCity, string DestinationCity, decimal? DistanceKm, decimal PayoutAmount, decimal? RevenueGame, DateTime? SubmittedAt, long DriverUserId, string Username, string DriverDisplayName, string RankName);
public sealed record PendingReviewEnvelope(IReadOnlyList<PendingReviewJob> Jobs);
public sealed record OwnerPayout(Guid Id, Guid JobId, decimal Amount, string Currency, string Status, int AttemptCount, DateTime? LeaseExpiresAt, decimal? BalanceBefore, decimal? BalanceAfter, string? LastError, DateTime? AppliedAt, DateTime CreatedAt, long DriverUserId, string Username, string DriverDisplayName);
public sealed record PayoutEnvelope(IReadOnlyList<OwnerPayout> Payouts);
public sealed record AuditEvent(long Id, string EventType, string? EntityType, string? EntityId, JsonElement? Metadata, DateTime CreatedAt, string? ActorUsername, string? ActorDisplayName, string? TargetUsername, string? TargetDisplayName);
public sealed record AuditEnvelope(IReadOnlyList<AuditEvent> Events);
public sealed record DriverHistoryStats(long TotalJobs, long CompletedJobs, decimal TotalDistanceKm, decimal TotalPaid);
public sealed record DriverHistoryJob(Guid Id, string Status, string Game, string Cargo, string OriginCity, string DestinationCity, decimal? DistanceKm, decimal PayoutAmount, decimal? RevenueGame, DateTime? SubmittedAt, DateTime? ApprovedAt, DateTime? PaidAt, DateTime CreatedAt);
public sealed record DriverHistoryEnvelope(OwnerDriver Driver, DriverHistoryStats Stats, IReadOnlyList<DriverHistoryJob> Jobs);
public sealed record SystemHealth(string Api, string Database, string Version, DateTime ServerTime, long ActiveAccounts, long TotalJobs, long TotalPayouts, long FailedPayouts);
public sealed record CreateDriverResponse(long Id, string Username, string DisplayName, string RankName);
public sealed record CreateJobResponse(Guid Id, string Status);
public sealed record OperationResponse(bool Ok, string? Status = null, bool Duplicate = false, Guid? PayoutId = null);
