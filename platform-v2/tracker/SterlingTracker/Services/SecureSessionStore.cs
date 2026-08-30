using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Sterling.Logistics.Tracker.Services;

public sealed class SecureSessionStore
{
    private readonly string _path;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Sterling.Logistics.Tracker.V2");

    public SecureSessionStore()
    {
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sterling Logistics", "Tracker");
        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, "session.dat");
    }

    public void Save(LoginResponse session)
    {
        var json = JsonSerializer.Serialize(session, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(json), Entropy, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(_path, encrypted);
    }

    public LoginResponse? Load()
    {
        if (!File.Exists(_path)) return null;
        try
        {
            var encrypted = File.ReadAllBytes(_path);
            var clear = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<LoginResponse>(clear, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }
        catch
        {
            Clear();
            return null;
        }
    }

    public void Clear()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }
}
