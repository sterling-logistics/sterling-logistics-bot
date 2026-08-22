using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace SterlingTracker;

internal sealed record Ets2PayoutApplyResult(long OldBalance, long NewBalance, string SavePath, string BackupPath);

internal static class Ets2PayoutService
{
    public static bool IsGameRunning()
    {
        return Process.GetProcessesByName("eurotrucks2").Length > 0;
    }

    public static Ets2PayoutApplyResult Apply(decimal amount)
    {
        if (amount <= 0) throw new InvalidOperationException("ETS2 payout amount must be greater than zero.");
        if (IsGameRunning()) throw new InvalidOperationException("Close Euro Truck Simulator 2 before Sterling applies the payout.");

        var save = FindNewestSave();
        if (save is null) throw new InvalidOperationException("No ETS2 game.sii save was found in Documents\\Euro Truck Simulator 2\\profiles or steam_profiles.");
        if ((DateTime.Now - save.LastWriteTime).TotalSeconds < 5) throw new InvalidOperationException("ETS2 save is still being written. Wait a few seconds and try again.");

        var lines = File.ReadAllLines(save.FullName);
        var joined = string.Join("\n", lines);
        if (!Regex.IsMatch(joined, @"\bmoney_account\s*:", RegexOptions.IgnoreCase))
        {
            EnsureTextSaveFormat();
            throw new InvalidOperationException("ETS2 save is encrypted. Sterling set g_save_format to 2. Start ETS2, make one fresh save, close ETS2, then the payout will apply automatically.");
        }

        var stack = new List<string>();
        var bankIndex = -1;
        var economyIndex = -1;
        var genericIndex = -1;
        var blockStart = new Regex(@"^([A-Za-z0-9_]+)\s*:\s*\S+\s*\{$", RegexOptions.Compiled);
        var moneyLine = new Regex(@"^(\s*)money_account\s*:\s*(-?\d+)\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        for (var i = 0; i < lines.Length; i++)
        {
            var t = lines[i].Trim();
            var bm = blockStart.Match(t);
            if (bm.Success)
            {
                stack.Add(bm.Groups[1].Value);
                continue;
            }
            if (t == "}")
            {
                if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
                continue;
            }
            if (!moneyLine.IsMatch(lines[i])) continue;
            if (genericIndex < 0) genericIndex = i;
            var current = stack.Count > 0 ? stack[^1] : "";
            if (current.Equals("bank", StringComparison.OrdinalIgnoreCase) && bankIndex < 0) bankIndex = i;
            else if (current.Equals("economy", StringComparison.OrdinalIgnoreCase) && economyIndex < 0) economyIndex = i;
        }

        var idx = bankIndex >= 0 ? bankIndex : economyIndex >= 0 ? economyIndex : genericIndex;
        if (idx < 0) throw new InvalidOperationException("Could not locate ETS2 money_account in the save.");
        var match = moneyLine.Match(lines[idx]);
        if (!match.Success) throw new InvalidOperationException("Could not parse ETS2 money_account.");

        var oldBalance = long.Parse(match.Groups[2].Value);
        var add = checked((long)Math.Truncate(amount));
        var newBalance = checked(oldBalance + add);
        if (newBalance < 0) throw new InvalidOperationException("The resulting ETS2 balance would be invalid.");

        var backup = save.FullName + ".sterling-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
        File.Copy(save.FullName, backup, true);
        lines[idx] = $"{match.Groups[1].Value}money_account: {newBalance}";
        File.WriteAllLines(save.FullName, lines, new UTF8Encoding(false));

        return new Ets2PayoutApplyResult(oldBalance, newBalance, save.FullName, backup);
    }

    private static FileInfo? FindNewestSave()
    {
        var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        var ets2 = Path.Combine(docs, "Euro Truck Simulator 2");
        var roots = new[] { Path.Combine(ets2, "profiles"), Path.Combine(ets2, "steam_profiles") };
        var saves = new List<FileInfo>();
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            try
            {
                saves.AddRange(Directory.EnumerateFiles(root, "game.sii", SearchOption.AllDirectories).Select(x => new FileInfo(x)));
            }
            catch { }
        }
        return saves.OrderByDescending(x => x.LastWriteTimeUtc).FirstOrDefault();
    }

    private static void EnsureTextSaveFormat()
    {
        try
        {
            var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            var config = Path.Combine(docs, "Euro Truck Simulator 2", "config.cfg");
            if (!File.Exists(config)) return;
            var text = File.ReadAllText(config);
            if (Regex.IsMatch(text, @"uset\s+g_save_format\s+\"[^\"]*\"", RegexOptions.IgnoreCase))
                text = Regex.Replace(text, @"uset\s+g_save_format\s+\"[^\"]*\"", "uset g_save_format \"2\"", RegexOptions.IgnoreCase);
            else
                text += Environment.NewLine + "uset g_save_format \"2\"" + Environment.NewLine;
            File.WriteAllText(config, text, new UTF8Encoding(false));
        }
        catch { }
    }
}
