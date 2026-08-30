using System.IO;
using System.Text.Json;

namespace Sterling.Logistics.Tracker.Services;

public sealed class JobSyncStateStore
{
    private readonly string _path;
    private readonly object _gate = new();
    private Dictionary<Guid, Guid>? _entries;

    public JobSyncStateStore()
    {
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sterling Logistics", "Tracker");
        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, "job-submissions.json");
    }

    public Guid GetOrCreateSubmissionId(Guid jobId)
    {
        lock (_gate)
        {
            var entries = LoadUnsafe();
            if (entries.TryGetValue(jobId, out var existing)) return existing;
            var created = Guid.NewGuid();
            entries[jobId] = created;
            SaveUnsafe(entries);
            return created;
        }
    }

    public void MarkSubmitted(Guid jobId)
    {
        lock (_gate)
        {
            var entries = LoadUnsafe();
            if (!entries.Remove(jobId)) return;
            SaveUnsafe(entries);
        }
    }

    private Dictionary<Guid, Guid> LoadUnsafe()
    {
        if (_entries is not null) return _entries;
        try
        {
            _entries = File.Exists(_path)
                ? JsonSerializer.Deserialize<Dictionary<Guid, Guid>>(File.ReadAllText(_path)) ?? new()
                : new();
        }
        catch
        {
            _entries = new();
        }
        return _entries;
    }

    private void SaveUnsafe(Dictionary<Guid, Guid> entries)
    {
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(entries));
        File.Move(temp, _path, true);
    }
}
