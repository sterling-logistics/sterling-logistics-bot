using System.IO;
using System.Text.Json;

namespace Sterling.Logistics.Tracker.Services;

public sealed class PayoutJournal
{
    private readonly string _directory;
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public PayoutJournal()
    {
        _directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sterling Logistics", "Tracker", "payout-journal");
        Directory.CreateDirectory(_directory);
    }

    public PayoutJournalEntry Create(PayoutClaim claim, string profilePath, decimal balanceBefore)
    {
        var entry = new PayoutJournalEntry(
            claim.Id,
            claim.JobId,
            claim.LeaseToken,
            Guid.NewGuid(),
            claim.Game,
            claim.Amount,
            profilePath,
            balanceBefore,
            null,
            PayoutJournalState.Prepared,
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow,
            null);
        Save(entry);
        return entry;
    }

    public PayoutJournalEntry MarkBackupCreated(PayoutJournalEntry entry, string backupPath)
        => Update(entry with { State = PayoutJournalState.BackupCreated, BackupPath = backupPath, UpdatedAt = DateTimeOffset.UtcNow });

    public PayoutJournalEntry MarkApplied(PayoutJournalEntry entry, decimal balanceAfter)
        => Update(entry with { State = PayoutJournalState.AppliedLocally, BalanceAfter = balanceAfter, UpdatedAt = DateTimeOffset.UtcNow });

    public PayoutJournalEntry MarkConfirmed(PayoutJournalEntry entry)
        => Update(entry with { State = PayoutJournalState.ConfirmedByServer, UpdatedAt = DateTimeOffset.UtcNow });

    public PayoutJournalEntry MarkFailed(PayoutJournalEntry entry, string error)
        => Update(entry with { State = PayoutJournalState.Failed, LastError = error, UpdatedAt = DateTimeOffset.UtcNow });

    public IReadOnlyList<PayoutJournalEntry> LoadUnfinished()
    {
        var result = new List<PayoutJournalEntry>();
        foreach (var file in Directory.EnumerateFiles(_directory, "*.json"))
        {
            try
            {
                var entry = JsonSerializer.Deserialize<PayoutJournalEntry>(File.ReadAllText(file), _json);
                if (entry is not null && entry.State != PayoutJournalState.ConfirmedByServer)
                    result.Add(entry);
            }
            catch
            {
                // Corrupt journal files are retained for manual recovery.
            }
        }
        return result.OrderBy(x => x.CreatedAt).ToList();
    }

    private PayoutJournalEntry Update(PayoutJournalEntry entry)
    {
        Save(entry);
        return entry;
    }

    private void Save(PayoutJournalEntry entry)
    {
        var path = Path.Combine(_directory, $"{entry.PayoutId:D}.json");
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(entry, _json));
        File.Move(temp, path, true);
    }
}

public enum PayoutJournalState
{
    Prepared,
    BackupCreated,
    AppliedLocally,
    ConfirmedByServer,
    Failed
}

public sealed record PayoutJournalEntry(
    Guid PayoutId,
    Guid JobId,
    Guid LeaseToken,
    Guid ApplicationId,
    string Game,
    decimal Amount,
    string ProfilePath,
    decimal BalanceBefore,
    decimal? BalanceAfter,
    PayoutJournalState State,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string? BackupPath,
    string? LastError = null);
