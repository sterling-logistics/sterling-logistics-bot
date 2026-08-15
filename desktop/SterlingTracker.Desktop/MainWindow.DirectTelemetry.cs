using System;
using System.Diagnostics;
using System.Text.Json;
using System.Threading.Tasks;
using SterlingTracker.Desktop.Telemetry;

namespace SterlingTracker.Desktop;

public partial class MainWindow
{
    readonly DirectTelemetryBridge directTelemetry = new();
    long lastDirectSequence;

    async Task DirectLiveLoop()
    {
        // The UI reads the newest RAM frame at up to 60fps. Cloud uploads are
        // still throttled separately and can never block the local gauges.
        while (running)
        {
            var frameClock = Stopwatch.StartNew();
            try
            {
                if ((DateTime.UtcNow - lastGameCheckAt).TotalMilliseconds >= 750)
                {
                    gameRunning = Process.GetProcessesByName("eurotrucks2").Length > 0;
                    lastGameCheckAt = DateTime.UtcNow;
                }

                if (!gameRunning)
                {
                    GameText.Text = "ETS2 not detected";
                    TelemetryText.Text = "Waiting for ETS2";
                    LiveStateText.Text = "WAITING";
                    PingText.Text = "—";
                    ConnectionText.Text = string.IsNullOrWhiteSpace(sessionToken) ? "Offline" : "Connected";
                    await Task.Delay(100);
                    continue;
                }

                GameText.Text = "ETS2 detected";

                if (directTelemetry.Error is not null)
                {
                    TelemetryText.Text = "Shared memory unavailable";
                    LiveStateText.Text = "REPAIR";
                    FooterText.Text = directTelemetry.Error.Message;
                    await Task.Delay(250);
                    continue;
                }

                if (!directTelemetry.TryGetLatest(out var json, out var sequence, out var ageMs))
                {
                    TelemetryText.Text = "Waiting for SDK data";
                    LiveStateText.Text = "SDK WAITING";
                    PingText.Text = "—";
                    await Task.Delay(30);
                    continue;
                }

                if (sequence != lastDirectSequence)
                {
                    lastDirectSequence = sequence;
                    using var doc = JsonDocument.Parse(json);
                    var raw = doc.RootElement.Clone();

                    if (!BoolAny(raw, "SdkActive"))
                    {
                        TelemetryText.Text = "SDK waiting";
                        LiveStateText.Text = "SDK WAITING";
                        PingText.Text = $"{ageMs:0} ms";
                    }
                    else
                    {
                        UpdateUi(raw);
                        TelemetryText.Text = "DIRECT LIVE TELEMETRY";
                        LiveStateText.Text = "LIVE";
                        PingText.Text = $"{ageMs:0} ms";
                        LastUpdatedText.Text = DateTime.Now.ToString("HH:mm:ss.fff");

                        if (!string.IsNullOrWhiteSpace(sessionToken) && !uploadBusy &&
                            (DateTime.UtcNow - lastUploadAt).TotalMilliseconds >= 750)
                        {
                            lastUploadAt = DateTime.UtcNow;
                            uploadBusy = true;
                            _ = UploadCycle(raw);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                TelemetryText.Text = "Telemetry reconnecting";
                LiveStateText.Text = "RECONNECTING";
                FooterText.Text = ex.Message.Length > 110 ? ex.Message[..110] : ex.Message;
            }

            var wait = 16 - (int)frameClock.ElapsedMilliseconds;
            if (wait > 0) await Task.Delay(wait);
            else await Task.Yield();
        }
    }
}
