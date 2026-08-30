namespace Sterling.Logistics.Tracker.Services;

public sealed class TrackerAgent : IAsyncDisposable
{
    private readonly SterlingApiClient _api;
    private readonly GameDetector _gameDetector;
    private readonly SecureSessionStore _sessionStore;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _sessionGate = new();
    private Task? _loop;
    private LoginResponse? _session;

    public event EventHandler<TrackerAgentStatus>? StatusChanged;

    public TrackerAgent(SterlingApiClient api, GameDetector gameDetector, SecureSessionStore sessionStore)
    {
        _api = api;
        _gameDetector = gameDetector;
        _sessionStore = sessionStore;
    }

    public LoginResponse? CurrentSession
    {
        get { lock (_sessionGate) return _session; }
    }

    public void Start(LoginResponse session)
    {
        lock (_sessionGate) _session = session;
        if (_loop is null)
            _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var session = CurrentSession;
            if (session is null) break;

            var game = _gameDetector.Detect();
            try
            {
                var jobs = await _api.GetMyJobsAsync(session.AccessToken, cancellationToken);
                var activeJob = jobs.FirstOrDefault(x => string.Equals(x.Status, "in_progress", StringComparison.OrdinalIgnoreCase));
                var onJob = activeJob is not null;
                var status = onJob ? "on_job" : game.IsRunning ? "driving" : "online";
                var heartbeat = new TrackerHeartbeat(
                    TrackerVersion: "2.0.0-alpha.2",
                    Game: game.Game ?? activeJob?.Game,
                    GameRunning: game.IsRunning,
                    OnJob: onJob,
                    Status: status,
                    Cargo: activeJob?.Cargo,
                    OriginCity: activeJob?.OriginCity,
                    DestinationCity: activeJob?.DestinationCity);

                await _api.SendHeartbeatAsync(session.AccessToken, heartbeat, cancellationToken);
                var jobText = onJob ? $" · {activeJob!.OriginCity} → {activeJob.DestinationCity}" : string.Empty;
                StatusChanged?.Invoke(this, new TrackerAgentStatus(true, game.Game, game.IsRunning, $"Connected{jobText}"));
            }
            catch (SterlingApiException ex) when (ex.StatusCode == 401)
            {
                try
                {
                    session = await _api.RefreshAsync(session.RefreshToken, cancellationToken);
                    lock (_sessionGate) _session = session;
                    _sessionStore.Save(session);
                    StatusChanged?.Invoke(this, new TrackerAgentStatus(true, game.Game, game.IsRunning, "Session refreshed"));
                }
                catch
                {
                    _sessionStore.Clear();
                    lock (_sessionGate) _session = null;
                    StatusChanged?.Invoke(this, new TrackerAgentStatus(false, game.Game, game.IsRunning, "Session expired"));
                    break;
                }
            }
            catch
            {
                StatusChanged?.Invoke(this, new TrackerAgentStatus(false, game.Game, game.IsRunning, "Offline - retrying"));
            }

            try { await Task.Delay(TimeSpan.FromSeconds(15), cancellationToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null)
        {
            try { await _loop; } catch (OperationCanceledException) { }
        }
        _cts.Dispose();
    }
}

public sealed record TrackerAgentStatus(bool ServerConnected, string? Game, bool GameRunning, string Message);
