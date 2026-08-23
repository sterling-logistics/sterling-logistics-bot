using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace SterlingTracker;

internal sealed record Ets2PayoutApplyResult(long OldBalance, long NewBalance, string SavePath, string BackupPath);

internal static class Ets2PayoutService
{
    public static bool IsGameRunning() => Process.GetProcessesByName("eurotrucks2").Length > 0;

    private static IReadOnlyList<string> CandidateEts2Roots()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void AddDocumentsRoot(string? documents)
        {
            if (string.IsNullOrWhiteSpace(documents)) return;
            try { roots.Add(Path.Combine(documents, "Euro Truck Simulator 2")); } catch { }
        }

        AddDocumentsRoot(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));

        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        AddDocumentsRoot(Path.Combine(userProfile, "Documents"));

        var oneDriveVars = new[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" };
        foreach (var name in oneDriveVars)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrWhiteSpace(value)) AddDocumentsRoot(Path.Combine(value, "Documents"));
        }

        try
        {
            foreach (var oneDrive in Directory.EnumerateDirectories(userProfile, "OneDrive*", SearchOption.TopDirectoryOnly))
                AddDocumentsRoot(Path.Combine(oneDrive, "Documents"));
        }
        catch { }

        return roots.ToList();
    }

    public static IReadOnlyList<FileInfo> FindSaves()
    {
        var saves = new List<FileInfo>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var ets2 in CandidateEts2Roots())
        {
            var roots = new[] { Path.Combine(ets2, "steam_profiles"), Path.Combine(ets2, "profiles") };
            foreach (var root in roots)
            {
                if (!Directory.Exists(root)) continue;
                try
                {
                    foreach (var path in Directory.EnumerateFiles(root, "game.sii", SearchOption.AllDirectories))
                    {
                        if (seen.Add(path))
                        {
                            var file = new FileInfo(path);
                            if (file.Exists) saves.Add(file);
                        }
                    }
                }
                catch { }
            }
        }

        return saves.OrderByDescending(x => x.LastWriteTimeUtc).ToList();
    }

    public static Ets2PayoutApplyResult Apply(decimal amount)
    {
        var save = FindSaves().FirstOrDefault() ?? throw new InvalidOperationException(
            "No ETS2 game.sii save was found. Sterling checked normal Documents plus OneDrive/redirected Documents folders. Open ETS2, load your TruckersMP profile, make a manual save, close ETS2 fully, then try again.");
        return ApplyToSave(amount, save.FullName);
    }

    public static Ets2PayoutApplyResult ApplyToSave(decimal amount, string savePath)
    {
        if (amount <= 0) throw new InvalidOperationException("ETS2 payout amount must be greater than zero.");
        if (IsGameRunning()) throw new InvalidOperationException("Close Euro Truck Simulator 2 and TruckersMP completely before applying the payout.");
        if (string.IsNullOrWhiteSpace(savePath) || !File.Exists(savePath)) throw new InvalidOperationException("The selected ETS2 game.sii save does not exist.");
        if (!Path.GetFileName(savePath).Equals("game.sii", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Select the game.sii file inside the save you actually load in ETS2/TMP.");

        var save = new FileInfo(savePath);
        if ((DateTime.Now - save.LastWriteTime).TotalSeconds < 3) throw new InvalidOperationException("ETS2 save is still being written. Wait a few seconds and try again.");

        var bytes = File.ReadAllBytes(save.FullName);
        var text = Encoding.UTF8.GetString(bytes);
        if (!Regex.IsMatch(text, @"\bmoney_account\s*:", RegexOptions.IgnoreCase))
        {
            EnsureTextSaveFormatFor(save.FullName);
            throw new InvalidOperationException("This save is still encrypted. Sterling has set g_save_format to 2 for the detected ETS2 folder. Start normal ETS2, load THIS profile, create a new manual save, exit ETS2 fully, then click Apply payout again and select that new save's game.sii.");
        }

        var lines = File.ReadAllLines(save.FullName);
        var moneyLine = new Regex(@"^(\s*)money_account\s*:\s*(-?\d+)\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        var idx = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            if (moneyLine.IsMatch(lines[i])) { idx = i; break; }
        }
        if (idx < 0) throw new InvalidOperationException("Could not locate money_account in the selected ETS2 save.");

        var match = moneyLine.Match(lines[idx]);
        var oldBalance = long.Parse(match.Groups[2].Value);
        var add = checked((long)Math.Truncate(amount));
        var newBalance = checked(oldBalance + add);
        if (newBalance < 0) throw new InvalidOperationException("The resulting ETS2 balance would be invalid.");

        var backup = save.FullName + ".sterling-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
        File.Copy(save.FullName, backup, true);
        lines[idx] = $"{match.Groups[1].Value}money_account: {newBalance}";
        File.WriteAllLines(save.FullName, lines, new UTF8Encoding(false));

        var verify = File.ReadAllText(save.FullName);
        if (!Regex.IsMatch(verify, $@"\bmoney_account\s*:\s*{newBalance}\b", RegexOptions.IgnoreCase))
        {
            File.Copy(backup, save.FullName, true);
            throw new InvalidOperationException("Sterling could not verify the new balance, so the original save was restored from backup.");
        }

        return new Ets2PayoutApplyResult(oldBalance, newBalance, save.FullName, backup);
    }

    public static string GetEts2Root()
    {
        return CandidateEts2Roots().FirstOrDefault(Directory.Exists)
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Euro Truck Simulator 2");
    }

    private static void EnsureTextSaveFormatFor(string savePath)
    {
        try
        {
            var dir = new DirectoryInfo(Path.GetDirectoryName(savePath)!);
            DirectoryInfo? ets2 = dir;
            while (ets2 is not null && !ets2.Name.Equals("Euro Truck Simulator 2", StringComparison.OrdinalIgnoreCase)) ets2 = ets2.Parent;
            var config = Path.Combine((ets2?.FullName ?? GetEts2Root()), "config.cfg");
            SetTextSaveFormat(config);
        }
        catch { EnsureTextSaveFormat(); }
    }

    private static void EnsureTextSaveFormat()
    {
        foreach (var root in CandidateEts2Roots())
        {
            try { SetTextSaveFormat(Path.Combine(root, "config.cfg")); } catch { }
        }
    }

    private static void SetTextSaveFormat(string config)
    {
        if (!File.Exists(config)) return;
        var text = File.ReadAllText(config);
        const string pattern = "uset\\s+g_save_format\\s+\"[^\"]*\"";
        if (Regex.IsMatch(text, pattern, RegexOptions.IgnoreCase))
            text = Regex.Replace(text, pattern, "uset g_save_format \"2\"", RegexOptions.IgnoreCase);
        else
            text += Environment.NewLine + "uset g_save_format \"2\"" + Environment.NewLine;
        File.WriteAllText(config, text, new UTF8Encoding(false));
    }
}
