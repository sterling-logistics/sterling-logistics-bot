using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace SterlingTracker;

internal sealed record Ets2PayoutApplyResult(long OldBalance, long NewBalance, string SavePath, string BackupPath);

internal static class Ets2PayoutService
{
    private const string Ets2AppId = "227300";
    private const string AtsAppId = "270880";
    private static readonly byte[] ScsKey = Convert.FromHexString("2A5FCB1791D22FB60245B3D8369ED0B2C27371563FBF1F3C9EDF6B11825A5D0A");

    public static bool IsGameRunning() =>
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
                    {
                        roots.Add(Path.Combine(userDir, appId, "remote", "profiles"));
                    }
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
        if (IsGameRunning()) throw new InvalidOperationException("Close ETS2/ATS and TruckersMP completely before applying the payout.");
        if (string.IsNullOrWhiteSpace(savePath) || !File.Exists(savePath)) throw new InvalidOperationException("The selected game.sii save does not exist.");
        if (!Path.GetFileName(savePath).Equals("game.sii", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Select the game.sii file inside the save you actually load.");

        var save = new FileInfo(savePath);
        if ((DateTime.Now - save.LastWriteTime).TotalSeconds < 3) throw new InvalidOperationException("The save is still being written. Wait a few seconds and try again.");

        var originalBytes = File.ReadAllBytes(save.FullName);
        var text = DecodeSaveToText(originalBytes);
        if (!Regex.IsMatch(text, @"\bmoney_account\s*:", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("Sterling decoded the save but could not locate money_account. Please select the game.sii from the exact profile/save you load.");

        var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var moneyLine = new Regex(@"^(\s*)money_account\s*:\s*(-?\d+)\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        var idx = Array.FindIndex(lines, line => moneyLine.IsMatch(line));
        if (idx < 0) throw new InvalidOperationException("Could not locate money_account in the decoded save.");

        var match = moneyLine.Match(lines[idx]);
        var oldBalance = long.Parse(match.Groups[2].Value);
        var add = checked((long)Math.Truncate(amount));
        var newBalance = checked(oldBalance + add);
        if (newBalance < 0) throw new InvalidOperationException("The resulting game balance would be invalid.");

        var backup = save.FullName + ".sterling-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
        File.Copy(save.FullName, backup, true);
        lines[idx] = $"{match.Groups[1].Value}money_account: {newBalance}";
        var output = string.Join(Environment.NewLine, lines);
        File.WriteAllText(save.FullName, output, new UTF8Encoding(false));

        var verify = File.ReadAllText(save.FullName);
        if (!Regex.IsMatch(verify, $@"\bmoney_account\s*:\s*{newBalance}\b", RegexOptions.IgnoreCase))
        {
            File.Copy(backup, save.FullName, true);
            throw new InvalidOperationException("Sterling could not verify the new balance, so the original save was restored from backup.");
        }

        EnsureTextSaveFormatFor(save.FullName);
        return new Ets2PayoutApplyResult(oldBalance, newBalance, save.FullName, backup);
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
        // Steam Cloud saves live under Steam\userdata, but g_save_format is still stored
        // in the game's Documents config. Set every detected ETS2/ATS config so the next
        // save remains plaintext after Sterling has converted this one.
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
