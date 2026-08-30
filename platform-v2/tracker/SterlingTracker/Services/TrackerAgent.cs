using System.Collections.Concurrent;

namespace Sterling.Logistics.Tracker.Services;

public sealed class TrackerAgent : IAsyncDisposable
{
    private readonly SterlingApiClient _api;
    private readonly GameDetector _gameDetector;
    private readonly SecureSessionStore _sessionStore;
    private readonly ScsTelemetryService _telemetry;
    private readonly JobSyncStateStore _jobSync;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _sessionGate = new();
    private readonly ConcurrentQueue<ScsTelemetryEvent> _telemetryEvents = new();
    private Task? _loop;
    private LoginResponse? _session;
    private IReadOnlyList<TrackerJob> _jobs = Array.Empty<TrackerJob>();
    private DateTimeOffset _jobsLoadedAt = DateTimeOffset.MinValue;
    private bool _trackerStartedEventSent;

    public event EventHandler<TrackerAgentStatus>? StatusChanged;

    public TrackerAgent(
        SterlingApiClient api,
        GameDetector gameDetector,
        SecureSessionStore sessionStore,
        ScsTelemetryService telemetry,
        JobSyncStateStore jobSync)
    {
        _api = api;
        _gameDetector = gameDetector;
        _sessionStore = sessionStore;
        _telemetry = telemetry;
        _jobSync = jobSync;
        _telemetry.TelemetryEvent += (_, telemetryEvent) => _telemetryEvents.Enqueue(telemetryEvent);
    }

    public LoginResponse? CurrentSession
    {
        get { lock (_sessionGate) return _session; }
    }

    public void Start(LoginResponse session)
    {
        lock (_sessionGate) _session = session;
        _telemetry.Start();
        if (_loop is null)
            _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var session = CurrentSession;
            if (session is null) break;

            var detectedGame = _gameDetector.Detect();
            var live = _telemetry.Latest;
            var game = live.SdkActive ? live.Game : detectedGame.Game;

            try
            {
                if (!_trackerStartedEventSent)
                {
                    await _api.SendTelemetryEventAsync(session.AccessToken,
                        new TrackerTelemetryEvent("tracker.started", game, null,
                            new Dictionary<string, object?> { ["trackerVersion"] = "2.0.0-alpha.3" }), cancellationToken);
                    _trackerStartedEventSent = true;
                }

                if (DateTimeOffset.UtcNow - _jobsLoadedAt >= TimeSpan.FromSeconds(10))
                {
                    _jobs = await _api.GetMyJobsAsync(session.AccessToken, cancellationToken);
                    _jobsLoadedAt = DateTimeOffset.UtcNow;
                }

                await ProcessTelemetryEventsAsync(session.AccessToken, cancellationToken);

                var activeJob = _jobs.FirstOrDefault(x => string.Equals(x.Status, "in_progress", StringComparison.OrdinalIgnoreCase));
                var onJob = live.SdkActive ? live.OnJob : activeJob is not null;
                var gameRunning = detectedGame.IsRunning || live.SdkActive;
                var status = onJob ? "on_job" : gameRunning ? (live.Paused ? "idle" : "driving") : "online";
                var heartbeat = new TrackerHeartbeat(
                    TrackerVersion: "2.0.0-alpha.3",
                    Game: game ?? activeJob?.Game,
                    GameRunning: gameRunning,
                    OnJob: onJob,
                    Status: status,
                    WorldX: live.SdkActive ? live.WorldX : null,
                    WorldY: live.SdkActive ? live.WorldY : null,
                    WorldZ: live.SdkActive ? live.WorldZ : null,
                    HeadingDeg: live.SdkActive ? live.HeadingDeg : null,
                    SpeedKph: live.SdkActive ? live.SpeedKph : null,
                    TruckMake: live.SdkActive ? live.TruckMake : null,
                    TruckModel: live.SdkActive ? live.TruckModel : null,
                    Cargo: live.SdkActive ? live.Cargo : activeJob?.Cargo,
                    OriginCity: live.SdkActive ? live.OriginCity : activeJob?.OriginCity,
                    DestinationCity: live.SdkActive ? live.DestinationCity : activeJob?.DestinationCity,
                    FuelPercent: live.SdkActive ? live.FuelPercent : null,
                    DamagePercent: live.SdkActive ? live.DamagePercent : null,
                    FinesTotal: live.SdkActive ? live.FinesTotal : null);

                await _api.SendHeartbeatAsync(session.AccessToken, heartbeat, cancellationToken);
                var jobText = onJob
                    ? $" · {heartbeat.OriginCity ?? "?"} → {heartbeat.DestinationCity ?? "?"}"
                    : string.Empty;
                var telemetryText = live.SdkActive ? " · telemetry live" : " · waiting for telemetry";
                StatusChanged?.Invoke(this, new TrackerAgentStatus(true, game, gameRunning, $"Connected{telemetryText}{jobText}"));
            }
            catch (SterlingApiException ex) when (ex.StatusCode == 401)
            {
                try
                {
                    session = await _api.RefreshAsync(session.RefreshToken, cancellationToken);
                    lock (_sessionGate) _session = session;
                    _sessionStore.Save(session);
                    StatusChanged?.Invoke(this, new TrackerAgentStatus(true, game, detectedGame.IsRunning, "Session refreshed"));
                }
                catch
                {
                    _sessionStore.Clear();
                    lock (_sessionGate) _session = null;
                    StatusChanged?.Invoke(this, new TrackerAgentStatus(false, game, detectedGame.IsRunning, "Session expired"));
                    break;
                }
            }
            catch (Exception ex)
            {
                StatusChanged?.Invoke(this, new TrackerAgentStatus(false, game, detectedGame.IsRunning, $"Offline - retrying · {ex.Message}"));
            }

            try { await Task.Delay(TimeSpan.FromSeconds(3), cancellationToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ProcessTelemetryEventsAsync(string accessToken, CancellationToken cancellationToken)
    {
        while (_telemetryEvents.TryDequeue(out var telemetryEvent))
        {
            try
            {
                switch (telemetryEvent.Type)
                {
                    case ScsTelemetryEventType.JobStarted:
                        await HandleJobStartedAsync(accessToken, telemetryEvent.Snapshot, cancellationToken);
                        break;
                    case ScsTelemetryEventType.JobDelivered:
                        await HandleJobDeliveredAsync(accessToken, telemetryEvent.Snapshot, cancellationToken);
                        break;
                    case ScsTelemetryEventType.JobCancelled:
                        await HandleJobCancelledAsync(accessToken, telemetryEvent.Snapshot, cancellationToken);
                        break;
                    case ScsTelemetryEventType.Fine:
                        await _api.SendTelemetryEventAsync(accessToken,
                            new TrackerTelemetryEvent("fine", telemetryEvent.Snapshot.Game, FindActiveJob()?.Id,
                                new Dictionary<string, object?>
                                {
                                    ["amount"] = telemetryEvent.Amount,
                                    ["finesTotal"] = telemetryEvent.Snapshot.FinesTotal,
                                    ["worldX"] = telemetryEvent.Snapshot.WorldX,
                                    ["worldZ"] = telemetryEvent.Snapshot.WorldZ
                                }), cancellationToken);
                        break;
                }
            }
            catch
            {
                _telemetryEvents.Enqueue(telemetryEvent);
                throw;
            }
        }
    }

    private async Task HandleJobStartedAsync(string accessToken, ScsTelemetrySnapshot live, CancellationToken cancellationToken)
    {
        var job = FindMatchingJob("assigned", live) ?? FindMatchingJob("in_progress", live);
        if (job is not null && string.Equals(job.Status, "assigned", StringComparison.OrdinalIgnoreCase))
        {
            await _api.StartJobAsync(accessToken, job.Id, cancellationToken);
            _jobs = _jobs.Select(x => x.Id == job.Id ? x with { Status = "in_progress" } : x).ToArray();
        }

        await _api.SendTelemetryEventAsync(accessToken,
            new TrackerTelemetryEvent("job.started", live.Game, job?.Id, BuildJobPayload(live)), cancellationToken);
    }

    private async Task HandleJobDeliveredAsync(string accessToken, ScsTelemetrySnapshot live, CancellationToken cancellationToken)
    {
        var job = FindMatchingJob("in_progress", live) ?? FindActiveJob();
        if (job is null)
        {
            await _api.SendTelemetryEventAsync(accessToken,
                new TrackerTelemetryEvent("job.delivered", live.Game, null, BuildJobPayload(live)), cancellationToken);
            return;
        }

        var submissionId = _jobSync.GetOrCreateSubmissionId(job.Id);
        var distance = live.DeliveredDistanceKm > 0 ? (decimal)live.DeliveredDistanceKm : live.PlannedDistanceKm;
        var revenue = live.DeliveredRevenue > 0 ? (decimal?)live.DeliveredRevenue : live.GameRevenue > 0 ? live.GameRevenue : null;
        var result = await _api.SubmitJobAsync(accessToken, job.Id, submissionId, distance, revenue, cancellationToken);
        if (result.Ok)
        {
            _jobSync.MarkSubmitted(job.Id);
            _jobs = _jobs.Select(x => x.Id == job.Id ? x with { Status = result.Status } : x).ToArray();
        }

        var payload = BuildJobPayload(live);
        payload["clientSubmissionId"] = submissionId;
        payload["autoApproved"] = result.AutoApproved;
        payload["resultStatus"] = result.Status;
        await _api.SendTelemetryEventAsync(accessToken,
            new TrackerTelemetryEvent("job.delivered", live.Game, job.Id, payload), cancellationToken);
    }

    private async Task HandleJobCancelledAsync(string accessToken, ScsTelemetrySnapshot live, CancellationToken cancellationToken)
    {
        var job = FindMatchingJob("in_progress", live) ?? FindActiveJob();
        await _api.SendTelemetryEventAsync(accessToken,
            new TrackerTelemetryEvent("job.cancelled", live.Game, job?.Id, BuildJobPayload(live)), cancellationToken);
    }

    private TrackerJob? FindActiveJob() => _jobs.FirstOrDefault(x => string.Equals(x.Status, "in_progress", StringComparison.OrdinalIgnoreCase));

    private TrackerJob? FindMatchingJob(string status, ScsTelemetrySnapshot live)
    {
        return _jobs.FirstOrDefault(job =>
            string.Equals(job.Status, status, StringComparison.OrdinalIgnoreCase) &&
            (string.IsNullOrWhiteSpace(live.Game) || string.Equals(job.Game, live.Game, StringComparison.OrdinalIgnoreCase)) &&
            Match(job.Cargo, live.Cargo) &&
            Match(job.OriginCity, live.OriginCity) &&
            Match(job.DestinationCity, live.DestinationCity));
    }

    private static bool Match(string expected, string? actual)
    {
        if (string.IsNullOrWhiteSpace(actual)) return true;
        return Normalize(expected) == Normalize(actual);
    }

    private static string Normalize(string? value)
        => new((value ?? string.Empty).Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    private static Dictionary<string, object?> BuildJobPayload(ScsTelemetrySnapshot live) => new()
    {
        ["cargo"] = live.Cargo,
        ["originCity"] = live.OriginCity,
        ["destinationCity"] = live.DestinationCity,
        ["originCompany"] = live.OriginCompany,
        ["destinationCompany"] = live.DestinationCompany,
        ["plannedDistanceKm"] = live.PlannedDistanceKm,
        ["deliveredDistanceKm"] = live.DeliveredDistanceKm,
        ["gameRevenue"] = live.GameRevenue,
        ["deliveredRevenue"] = live.DeliveredRevenue,
        ["damagePercent"] = live.DamagePercent,
        ["cargoDamagePercent"] = live.DeliveredCargoDamagePercent > 0 ? live.DeliveredCargoDamagePercent : live.CargoDamagePercent,
        ["finesTotal"] = live.FinesTotal,
        ["worldX"] = live.WorldX,
        ["worldY"] = live.WorldY,
        ["worldZ"] = live.WorldZ
    };

    public async ValueTask DisposeAsync()
    {
        var session = CurrentSession;
        if (session is not null)
        {
            try
            {
                await _api.SendTelemetryEventAsync(session.AccessToken,
                    new TrackerTelemetryEvent("tracker.stopped", _telemetry.Latest.Game, null), CancellationToken.None);
            }
            catch { }
        }

        _cts.Cancel();
        if (_loop is not null)
        {
            try { await _loop; } catch (OperationCanceledException) { }
        }
        _telemetry.Dispose();
        _cts.Dispose();
    }
}

public sealed record TrackerAgentStatus(bool ServerConnected, string? Game, bool GameRunning, string Message);
