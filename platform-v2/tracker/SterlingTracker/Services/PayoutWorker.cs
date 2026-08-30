namespace Sterling.Logistics.Tracker.Services;

public sealed class PayoutWorker : IAsyncDisposable
{
    private readonly SterlingApiClient _api;
    private readonly TrackerAgent _agent;
    private readonly PayoutJournal _journal;
    private readonly GamePayoutService _gamePayout;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

    public event EventHandler<string>? StatusChanged;

    public PayoutWorker(SterlingApiClient api, TrackerAgent agent, PayoutJournal journal)
    {
        _api = api;
        _agent = agent;
        _journal = journal;
        _gamePayout = new GamePayoutService(journal);
    }

    public void Start()
    {
        if (_loop is null) _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var session = _agent.CurrentSession;
            if (session is not null)
            {
                try
                {
                    var claim = await _api.ClaimNextPayoutAsync(session.AccessToken, cancellationToken);
                    if (claim is not null) await ProcessClaimAsync(session, claim, cancellationToken);
                }
                catch (SterlingApiException ex) when (ex.StatusCode == 401)
                {
                    StatusChanged?.Invoke(this, "Payout service waiting for session refresh.");
                }
                catch (Exception ex)
                {
                    StatusChanged?.Invoke(this, $"Payout service retrying: {ex.Message}");
                }
            }

            try { await Task.Delay(TimeSpan.FromSeconds(30), cancellationToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ProcessClaimAsync(LoginResponse session, PayoutClaim claim, CancellationToken cancellationToken)
    {
        var existing = _journal.LoadUnfinished()
            .Where(x => x.PayoutId == claim.Id)
            .OrderByDescending(x => x.UpdatedAt)
            .FirstOrDefault();

        try
        {
            var result = _gamePayout.Apply(claim, existing);
            await _api.CompletePayoutAsync(
                session.AccessToken,
                claim.Id,
                claim.LeaseToken,
                result.Journal.ApplicationId,
                result.BalanceBefore,
                result.BalanceAfter,
                cancellationToken);
            _journal.MarkConfirmed(result.Journal);
            StatusChanged?.Invoke(this, $"Sterling payout {claim.Amount:0} applied and verified.");
        }
        catch (PayoutDeferredException ex)
        {
            await SafeReleaseClaimAsync(session, claim, ex.Message, cancellationToken);
            StatusChanged?.Invoke(this, ex.Message);
        }
        catch (Exception ex)
        {
            // If money was already written locally, keep the journal intact. The next lease
            // will reconcile the current balance and confirm instead of applying it again.
            await SafeReleaseClaimAsync(session, claim, ex.Message, cancellationToken);
            StatusChanged?.Invoke(this, $"Payout paused safely: {ex.Message}");
        }
    }

    private async Task SafeReleaseClaimAsync(LoginResponse session, PayoutClaim claim, string error, CancellationToken cancellationToken)
    {
        try
        {
            await _api.FailPayoutAsync(session.AccessToken, claim.Id, claim.LeaseToken, error[..Math.Min(error.Length, 900)], cancellationToken);
        }
        catch
        {
            // Lease expiry makes the claim recoverable server-side; the local journal remains the source of truth.
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
