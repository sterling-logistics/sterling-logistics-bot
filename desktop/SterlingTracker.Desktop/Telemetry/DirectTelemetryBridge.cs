using System;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;
using SCSSdkClient;
using SCSSdkClient.Object;

namespace SterlingTracker.Desktop.Telemetry;

/// <summary>
/// Reads ETS2 telemetry straight from Local\SCSTelemetry through the RenCloud
/// shared-memory client. There is deliberately no localhost HTTP service in
/// this path. The newest frame is kept in RAM for the WPF UI.
/// </summary>
internal sealed class DirectTelemetryBridge : IDisposable
{
    readonly SCSSdkTelemetry telemetry;
    readonly JsonSerializerOptions jsonOptions = new() { PropertyNamingPolicy = null };
    string latestJson = "";
    long latestSequence;
    long latestCapturedTicks;

    public DirectTelemetryBridge()
    {
        // 25 ms = up to 40 local samples/second. The game's own telemetry
        // timestamp still decides when values actually change.
        telemetry = new SCSSdkTelemetry(25);
        telemetry.Data += OnTelemetry;
    }

    public Exception? Error => telemetry.Error;

    void OnTelemetry(SCSTelemetry data, bool newTimestamp)
    {
        if (data is null) return;
        try
        {
            var json = JsonSerializer.Serialize(data, jsonOptions);
            Volatile.Write(ref latestJson, json);
            Interlocked.Exchange(ref latestCapturedTicks, Stopwatch.GetTimestamp());
            Interlocked.Increment(ref latestSequence);
        }
        catch
        {
            // Keep the last known good frame. The UI remains responsive and
            // the next SDK tick gets another chance immediately.
        }
    }

    public bool TryGetLatest(out string json, out long sequence, out double ageMs)
    {
        json = Volatile.Read(ref latestJson);
        sequence = Interlocked.Read(ref latestSequence);
        var captured = Interlocked.Read(ref latestCapturedTicks);
        ageMs = captured == 0 ? double.PositiveInfinity :
            (Stopwatch.GetTimestamp() - captured) * 1000.0 / Stopwatch.Frequency;
        return json.Length > 0;
    }

    public void Dispose()
    {
        telemetry.Data -= OnTelemetry;
        telemetry.Dispose();
    }
}
