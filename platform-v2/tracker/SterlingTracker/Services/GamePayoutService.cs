using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Sterling.Logistics.Tracker.Services;

public sealed class GamePayoutService
{
    private static readonly Regex MoneyRegex = new(@"^(\s*)money_account\s*:\s*(-?\d+)\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.Multiline);
    private readonly PayoutJournal _journal;

    public GamePayoutService(PayoutJournal journal) => _journal = journal;

    public GamePayoutApplyResult Apply(PayoutClaim claim, PayoutJournalEntry? existing = null)
    {
        if (claim.Amount <= 0) throw new InvalidOperationException("Payout amount must be greater than zero.");
        if (decimal.Truncate(claim.Amount) != claim.Amount)
            throw new InvalidOperationException("Game payouts must be whole currency units so Sterling can verify the exact game balance.");
        if (IsGameRunning(claim.Game))
            throw new PayoutDeferredException("Sterling will apply the payment at the next safe save point after the game closes.");

        var save = ResolveSave(claim.Game, existing);
        EnsureStable(save);
        var original = File.ReadAllText(save.FullName, Encoding.UTF8);
        var beforeNow = ParseBalance(original);

        if (existing is not null)
        {
            var expected = checked(existing.BalanceBefore + claim.Amount);
            if (beforeNow == expected)
            {
                var reconciled = _journal.MarkApplied(existing, beforeNow);
                return new GamePayoutApplyResult(reconciled, existing.BalanceBefore, beforeNow, save.FullName, existing.BackupPath ?? string.Empty);
            }
            if (beforeNow != existing.BalanceBefore)
                throw new PayoutDeferredException("Sterling detected a balance change during payout recovery. The payment has been paused for Owner review instead of risking a duplicate.");
        }

        var before = existing?.BalanceBefore ?? beforeNow;
        var after = checked(before + claim.Amount);
        var journal = existing ?? _journal.Create(claim, save.FullName, before);

        var backup = journal.BackupPath;
        if (string.IsNullOrWhiteSpace(backup) || !File.Exists(backup))
        {
            backup = save.FullName + $".sterling-backup-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{claim.Id:N}";
            File.Copy(save.FullName, backup, overwrite: false);
            journal = _journal.MarkBackupCreated(journal, backup);
        }

        var match = MoneyRegex.Match(original);
        var replacement = $"{match.Groups[1].Value}money_account: {after.ToString(CultureInfo.InvariantCulture)}";
        var updated = MoneyRegex.Replace(original, replacement, 1);
        var temp = save.FullName + $".sterling-{claim.Id:N}.tmp";
        File.WriteAllText(temp, updated, new UTF8Encoding(false));
        File.Move(temp, save.FullName, overwrite: true);

        var verify = File.ReadAllText(save.FullName, Encoding.UTF8);
        var verified = ParseBalance(verify);
        if (verified != after)
        {
            TryRestore(backup, save.FullName);
            _journal.MarkFailed(journal, "Balance verification failed after write; backup restored.");
            throw new InvalidOperationException("Sterling could not verify the game payment and restored the backup.");
        }

        journal = _journal.MarkApplied(journal, verified);
        return new GamePayoutApplyResult(journal, before, verified, save.FullName, backup);
    }

    public static decimal ReadBalance(string savePath)
        => ParseBalance(File.ReadAllText(savePath, Encoding.UTF8));

    public static FileInfo? FindLatestSave(string game)
    {
        var folderName = string.Equals(game, "ats", StringComparison.OrdinalIgnoreCase)
            ? "American Truck Simulator"
            : "Euro Truck Simulator 2";
        var roots = CandidateDocumentRoots()
            .Select(root => Path.Combine(root, folderName))
            .Where(Directory.Exists)
            .Distinct(StringComparer.OrdinalIgnoreCase);

        var candidates = new List<FileInfo>();
        foreach (var root in roots)
        {
            foreach (var profilesFolder in new[] { "steam_profiles", "profiles" })
            {
                var path = Path.Combine(root, profilesFolder);
                if (!Directory.Exists(path)) continue;
                try
                {
                    candidates.AddRange(Directory.EnumerateFiles(path, "game.sii", SearchOption.AllDirectories).Select(x => new FileInfo(x)));
                }
                catch (UnauthorizedAccessException) { }
                catch (IOException) { }
            }
        }
        return candidates.Where(x => x.Exists).OrderByDescending(x => x.LastWriteTimeUtc).FirstOrDefault();
    }

    private static FileInfo ResolveSave(string game, PayoutJournalEntry? existing)
    {
        if (existing is not null && File.Exists(existing.ProfilePath)) return new FileInfo(existing.ProfilePath);
        return FindLatestSave(game) ?? throw new PayoutDeferredException($"No {game.ToUpperInvariant()} game.sii save was found yet.");
    }

    private static decimal ParseBalance(string text)
    {
        var match = MoneyRegex.Match(text);
        if (!match.Success)
            throw new PayoutDeferredException("Sterling cannot safely edit this save yet. Set g_save_format to 2 in the game config and create a fresh save.");
        return decimal.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
    }

    private static IEnumerable<string> CandidateDocumentRoots()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(string? path) { if (!string.IsNullOrWhiteSpace(path)) roots.Add(path); }
        Add(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Documents"));
        foreach (var key in new[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" })
        {
            var oneDrive = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrWhiteSpace(oneDrive)) Add(Path.Combine(oneDrive, "Documents"));
        }
        return roots;
    }

    private static bool IsGameRunning(string game)
        => string.Equals(game, "ats", StringComparison.OrdinalIgnoreCase)
            ? Process.GetProcessesByName("amtrucks").Length > 0
            : Process.GetProcessesByName("eurotrucks2").Length > 0;

    private static void EnsureStable(FileInfo save)
    {
        save.Refresh();
        var modified = save.LastWriteTimeUtc;
        var length = save.Length;
        Thread.Sleep(500);
        save.Refresh();
        if (save.LastWriteTimeUtc != modified || save.Length != length)
            throw new PayoutDeferredException("The game save is currently changing. Sterling will retry automatically.");
    }

    private static void TryRestore(string backup, string target)
    {
        try { if (File.Exists(backup)) File.Copy(backup, target, overwrite: true); } catch { }
    }
}

public sealed record GamePayoutApplyResult(PayoutJournalEntry Journal, decimal BalanceBefore, decimal BalanceAfter, string SavePath, string BackupPath);
public sealed class PayoutDeferredException : Exception
{
    public PayoutDeferredException(string message) : base(message) { }
}
