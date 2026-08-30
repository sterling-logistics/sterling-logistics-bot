namespace Sterling.Logistics.Tracker.Services;

public sealed class TrackerAgent : IAsyncDisposable
{
    private readonly SterlingApiClient _api;
    private readonly GameDetector _gameDetector;
    private readonly SecureSessionStore _sessionStore;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;
    private LoginResponse? _session;

    public event EventHandler<TrackerAgentStatus>? StatusChanged;

    public TrackerAgent(SterlingApiClient api, GameDetector gameDetector, SecureSessionStore sessionStore)
    {
        _api = api;
        _gameDetector = gameDetector;
        _sessionStore = sessionStore;
    }

    public void Start(LoginResponse session)
    {
        _session = session;
        if (_loop is null)
            _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var session = _session;
            if (session is null) break;

            var game = _gameDetector.Detect();
            var status = game.IsRunning ? "driving" : "online";
            var heartbeat = new TrackerHeartbeat(
                TrackerVersion: "2.0.0-alpha.2",
                Game: game.Game,
                GameRunning: game.IsRunning,
                OnJob: false,
                Status: status);

            try
            {
                await _api.SendHeartbeatAsync(session.AccessToken, heartbeat, cancellationToken);
                StatusChanged?.Invoke(this, new TrackerAgentStatus(true, game.Game, game.IsRunning, "Connected"));
            }
            catch (SterlingApiException ex) when (ex.StatusCode == 401)
            {
                try
                {
                    session = await _api.RefreshAsync(session.RefreshToken, cancellationToken);
                    _session = session;
                    _sessionStore.Save(session);
                    await _api.SendHeartbeatAsync(session.AccessToken, heartbeat, cancellationToken);
                    StatusChanged?.Invoke(this, new TrackerAgentStatus(true, game.Game, game.IsRunning, "Connected"));
                }
                catch
                {
                    _sessionStore.Clear();
                    StatusChanged?.Invoke(this, new TrackerAgentStatus(false, game.Game, game.IsRunning, "Session expired"));
                    break;
                }
            }
            catch
            {
                StatusChanged?.Invoke(this, new TrackerAgentStatus(false, game.Game, game.IsRunning, "Offline - retrying"));
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(15), cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
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
