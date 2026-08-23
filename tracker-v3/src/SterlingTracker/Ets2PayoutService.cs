using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace SterlingTracker;

internal sealed record Ets2PayoutApplyResult(long OldBalance, long NewBalance, string SavePath, string BackupPath);
internal sealed class PayoutSyncPendingException : Exception
{
    public PayoutSyncPendingException(string message) : base(message) { }
}

internal static class Ets2PayoutService
{
    private const string Ets2AppId = "227300";
    private const string AtsAppId = "270880";
    private static readonly byte[] ScsKey = Convert.FromHexString("2A5FCB1791D22FB60245B3D8369ED0B2C27371563FBF1F3C9EDF6B11825A5D0A");

    private sealed class LiveSyncMarker
    {
        public decimal Amount { get; set; }
        public long BaseBalance { get; set; }
        public long TargetBalance { get; set; }
        public string BackupPath { get; set; } = "";
        public string LastSavePath { get; set; } = "";
        public DateTime LastStagedWriteUtc { get; set; }
        public DateTime CreatedUtc { get; set; }
    }

    public static bool IsGameRunning() => IsSimulatorProcessRunning();

    private static bool IsSimulatorProcessRunning() =>
        Process.GetProcessesByName("eurotrucks2").Length > 0 ||
        Process.GetProcessesByName("amtrucks").Length > 0;

    private static IReadOnlyList<string> CandidateGameRoots()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void AddDocumentsRoot(string? documents)
        {
            if (string.IsNullOrWhiteSpace(documents)) return;
            try
            {
                roots.Add(Path.Combine(documents, "Euro Truck Simulator 2"));
                roots.Add(Path.Combine(documents, "American Truck Simulator"));
            }
            catch { }
        }

        AddDocumentsRoot(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        AddDocumentsRoot(Path.Combine(userProfile, "Documents"));

        foreach (var name in new[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" })
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

    private static IReadOnlyList<string> CandidateSteamRoots()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            path = path.Replace('/', '\\').TrimEnd('\\');
            if (Directory.Exists(path)) roots.Add(path);
        }

        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
            Add(key?.GetValue("SteamPath")?.ToString());
        }
        catch { }
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Valve\Steam");
            Add(key?.GetValue("InstallPath")?.ToString());
        }
        catch { }

        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam"));
        Add(@"C:\Steam");
        foreach (var drive in DriveInfo.GetDrives().Where(d => d.IsReady))
        {
            try
            {
                Add(Path.Combine(drive.RootDirectory.FullName, "Steam"));
                Add(Path.Combine(drive.RootDirectory.FullName, "steam"));
                Add(Path.Combine(drive.RootDirectory.FullName, "SteamLibrary"));
            }
            catch { }
        }
        return roots.ToList();
    }

    private static IReadOnlyList<string> CandidateProfileContainers()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var game in CandidateGameRoots())
        {
            roots.Add(Path.Combine(game, "steam_profiles"));
            roots.Add(Path.Combine(game, "profiles"));
        }

        foreach (var steam in CandidateSteamRoots())
        {
            var userdata = Path.Combine(steam, "userdata");
            if (!Directory.Exists(userdata)) continue;
            try
            {
                foreach (var userDir in Directory.EnumerateDirectories(userdata))
                {
                    foreach (var appId in new[] { Ets2AppId, AtsAppId })
                        roots.Add(Path.Combine(userDir, appId, "remote", "profiles"));
                }
            }
            catch { }
        }
        return roots.ToList();
    }

    public static IReadOnlyList<FileInfo> FindSaves()
    {
        var saves = new List<FileInfo>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in CandidateProfileContainers())
        {
            if (!Directory.Exists(root)) continue;
            try
            {
                foreach (var path in Directory.EnumerateFiles(root, "game.sii", SearchOption.AllDirectories))
                {
                    if (!seen.Add(path)) continue;
                    var file = new FileInfo(path);
                    if (file.Exists) saves.Add(file);
                }
            }
            catch { }
        }
        return saves.OrderByDescending(x => x.LastWriteTimeUtc).ToList();
    }

    public static string? GetProfileRootForSave(string savePath)
    {
        if (string.IsNullOrWhiteSpace(savePath)) return null;
        try
        {
            var dir = new DirectoryInfo(Path.GetDirectoryName(savePath)!);
            while (dir.Parent is not null)
            {
                if (dir.Parent.Name.Equals("profiles", StringComparison.OrdinalIgnoreCase) ||
                    dir.Parent.Name.Equals("steam_profiles", StringComparison.OrdinalIgnoreCase))
                    return dir.FullName;
                dir = dir.Parent;
            }
        }
        catch { }
        return null;
    }

    public static FileInfo? FindLatestSaveInProfile(string? profileRoot)
    {
        if (string.IsNullOrWhiteSpace(profileRoot) || !Directory.Exists(profileRoot)) return null;
        try
        {
            return Directory.EnumerateFiles(profileRoot, "game.sii", SearchOption.AllDirectories)
                .Select(x => new FileInfo(x)).Where(x => x.Exists)
                .OrderByDescending(x => x.LastWriteTimeUtc).FirstOrDefault();
        }
        catch { return null; }
    }

    public static IReadOnlyList<string> FindProfileRoots() => FindSaves()
        .Select(x => GetProfileRootForSave(x.FullName)).Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.OrdinalIgnoreCase).Cast<string>().ToList();

    public static Ets2PayoutApplyResult Apply(decimal amount)
    {
        var save = FindSaves().FirstOrDefault() ?? throw new InvalidOperationException(
            "No ETS2/ATS game.sii save was found. Sterling checked Documents, OneDrive and Steam Cloud userdata for ETS2 and ATS.");
        return ApplyToSave(amount, save.FullName);
    }

    public static Ets2PayoutApplyResult ApplyToSave(decimal amount, string savePath)
    {
        if (amount <= 0) throw new InvalidOperationException("Game payout amount must be greater than zero.");
        if (string.IsNullOrWhiteSpace(savePath) || !File.Exists(savePath)) throw new InvalidOperationException("The selected game.sii save does not exist.");
        if (!Path.GetFileName(savePath).Equals("game.sii", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Select the game.sii file inside the save you actually load.");

        var save = new FileInfo(savePath);
        EnsureSaveStable(save);

        var originalBytes = ReadStableBytes(save.FullName);
        var text = DecodeSaveToText(originalBytes);
        var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var moneyLine = new Regex(@"^(\s*)money_account\s*:\s*(-?\d+)\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        var idx = Array.FindIndex(lines, line => moneyLine.IsMatch(line));
        if (idx < 0) throw new InvalidOperationException("Sterling decoded the save but could not locate money_account in this profile.");

        var match = moneyLine.Match(lines[idx]);
        var currentBalance = long.Parse(match.Groups[2].Value);
        var add = checked((long)Math.Truncate(amount));
        if (add <= 0) throw new InvalidOperationException("The payout is too small to apply to the game balance.");

        var running = IsSimulatorProcessRunning();
        var profileRoot = GetProfileRootForSave(save.FullName) ?? save.DirectoryName ?? Path.GetDirectoryName(save.FullName)!;
        var markerPath = Path.Combine(profileRoot, ".sterling-live-sync.json");
        var marker = LoadMarker(markerPath);
        if (marker is not null && (DateTime.UtcNow - marker.CreatedUtc) > TimeSpan.FromDays(2))
        {
            TryDelete(markerPath);
            marker = null;
        }
        if (marker is not null && Math.Abs(marker.Amount - amount) > 0.005m)
        {
            TryDelete(markerPath);
            marker = null;
        }

        if (marker is not null)
        {
            if (!running)
            {
                var finalTarget = currentBalance == marker.TargetBalance ? marker.TargetBalance : checked(currentBalance + add);
                var backup = EnsureBackup(save.FullName, marker.BackupPath);
                WriteBalance(save, lines, idx, match.Groups[1].Value, finalTarget);
                EnsureTextSaveFormatFor(save.FullName);
                TryDelete(markerPath);
                return new Ets2PayoutApplyResult(finalTarget - add, finalTarget, save.FullName, backup);
            }

            var gameWroteAfterStage = save.LastWriteTimeUtc > marker.LastStagedWriteUtc.AddMilliseconds(750);
            if (gameWroteAfterStage && currentBalance >= marker.TargetBalance)
            {
                EnsureTextSaveFormatFor(save.FullName);
                TryDelete(markerPath);
                return new Ets2PayoutApplyResult(marker.TargetBalance - add, currentBalance, save.FullName, marker.BackupPath);
            }

            if (gameWroteAfterStage && currentBalance != marker.TargetBalance)
            {
                var delta = checked(currentBalance - marker.BaseBalance);
                marker.BaseBalance = currentBalance;
                marker.TargetBalance = checked(marker.TargetBalance + delta);
            }

            if (currentBalance != marker.TargetBalance || !string.Equals(save.FullName, marker.LastSavePath, StringComparison.OrdinalIgnoreCase))
            {
                WriteBalance(save, lines, idx, match.Groups[1].Value, marker.TargetBalance);
                save.Refresh();
                marker.LastSavePath = save.FullName;
                marker.LastStagedWriteUtc = save.LastWriteTimeUtc;
                SaveMarker(markerPath, marker);
            }

            throw new PayoutSyncPendingException(
                "Sterling has staged this payout while the game is open. Keep Tracker running; it will confirm the payment automatically at the next safe save/reload point. You do not need to close ETS2/ATS or TruckersMP.");
        }

        var target = checked(currentBalance + add);
        if (target < 0) throw new InvalidOperationException("The resulting game balance would be invalid.");
        var backupPath = EnsureBackup(save.FullName, null);
        WriteBalance(save, lines, idx, match.Groups[1].Value, target);
        EnsureTextSaveFormatFor(save.FullName);

        if (!running)
            return new Ets2PayoutApplyResult(currentBalance, target, save.FullName, backupPath);

        save.Refresh();
        var newMarker = new LiveSyncMarker
        {
            Amount = amount,
            BaseBalance = currentBalance,
            TargetBalance = target,
            BackupPath = backupPath,
            LastSavePath = save.FullName,
            LastStagedWriteUtc = save.LastWriteTimeUtc,
            CreatedUtc = DateTime.UtcNow
        };
        SaveMarker(markerPath, newMarker);
        throw new PayoutSyncPendingException(
            "Sterling has staged this payout while the game is open. Keep Tracker running; it will confirm the payment automatically at the next safe save/reload point. You do not need to close ETS2/ATS or TruckersMP.");
    }

    private static byte[] ReadStableBytes(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var ms = new MemoryStream();
            stream.CopyTo(ms);
            return ms.ToArray();
        }
        catch (IOException ex)
        {
            throw new PayoutSyncPendingException("The game is writing its save right now. Sterling will retry automatically in a few seconds. " + ex.Message);
        }
    }

    private static void EnsureSaveStable(FileInfo save)
    {
        save.Refresh();
        var write = save.LastWriteTimeUtc;
        var length = save.Length;
        Thread.Sleep(650);
        save.Refresh();
        if (save.LastWriteTimeUtc != write || save.Length != length)
            throw new PayoutSyncPendingException("The game is saving right now. Sterling will retry automatically in a few seconds.");
    }

    private static string EnsureBackup(string savePath, string? existing)
    {
        if (!string.IsNullOrWhiteSpace(existing) && File.Exists(existing)) return existing;
        var backup = savePath + ".sterling-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
        File.Copy(savePath, backup, true);
        return backup;
    }

    private static void WriteBalance(FileInfo save, string[] sourceLines, int idx, string indent, long target)
    {
        var lines = (string[])sourceLines.Clone();
        lines[idx] = $"{indent}money_account: {target}";
        var output = string.Join(Environment.NewLine, lines);
        var temp = save.FullName + ".sterling-write";
        try
        {
            File.WriteAllText(temp, output, new UTF8Encoding(false));
            File.Move(temp, save.FullName, true);
        }
        catch (IOException ex)
        {
            TryDelete(temp);
            throw new PayoutSyncPendingException("The game touched the save during Sterling sync. Tracker will retry automatically. " + ex.Message);
        }

        var verify = File.ReadAllText(save.FullName);
        if (!Regex.IsMatch(verify, $@"\bmoney_account\s*:\s*{target}\b", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("Sterling could not verify the staged game balance.");
    }

    private static LiveSyncMarker? LoadMarker(string path)
    {
        try { return File.Exists(path) ? JsonSerializer.Deserialize<LiveSyncMarker>(File.ReadAllText(path)) : null; }
        catch { return null; }
    }

    private static void SaveMarker(string path, LiveSyncMarker marker)
    {
        try { File.WriteAllText(path, JsonSerializer.Serialize(marker), new UTF8Encoding(false)); }
        catch (Exception ex) { throw new InvalidOperationException("Sterling could not save its live payout state: " + ex.Message, ex); }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static string DecodeSaveToText(byte[] bytes)
    {
        var direct = Encoding.UTF8.GetString(bytes);
        if (Regex.IsMatch(direct, @"\bmoney_account\s*:", RegexOptions.IgnoreCase)) return direct;

        if (bytes.Length < 56 || Encoding.ASCII.GetString(bytes, 0, 4) != "ScsC")
            throw new InvalidOperationException("This game.sii uses a binary format Sterling cannot safely edit yet. Set g_save_format to 2, create a fresh save, then try again.");

        try
        {
            var iv = bytes.AsSpan(36, 16).ToArray();
            var cipher = bytes.AsSpan(56).ToArray();
            using var aes = Aes.Create();
            aes.Key = ScsKey;
            aes.IV = iv;
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.None;
            using var decryptor = aes.CreateDecryptor();
            var decrypted = decryptor.TransformFinalBlock(cipher, 0, cipher.Length);
            using var input = new MemoryStream(decrypted);
            using var zlib = new ZLibStream(input, CompressionMode.Decompress);
            using var output = new MemoryStream();
            zlib.CopyTo(output);
            var decoded = output.ToArray();
            var text = Encoding.UTF8.GetString(decoded);
            if (Regex.IsMatch(text, @"\bmoney_account\s*:", RegexOptions.IgnoreCase)) return text;
            throw new InvalidOperationException("The encrypted save decrypted successfully but contains binary SII data rather than editable text.");
        }
        catch (InvalidOperationException) { throw; }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Sterling could not decrypt this SCS save safely: " + ex.Message, ex);
        }
    }

    public static string GetEts2Root() => CandidateGameRoots().FirstOrDefault(Directory.Exists)
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Euro Truck Simulator 2");

    private static void EnsureTextSaveFormatFor(string savePath)
    {
        foreach (var root in CandidateGameRoots())
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
        else text += Environment.NewLine + "uset g_save_format \"2\"" + Environment.NewLine;
        File.WriteAllText(config, text, new UTF8Encoding(false));
    }
}
