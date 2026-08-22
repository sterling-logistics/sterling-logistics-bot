# Sterling Tracker 3.0

Clean rewrite of the Sterling Logistics Windows tracker.

This tree intentionally contains no code from the 2.x tracker.

## Build order

1. Prove direct ETS2 telemetry ingestion.
2. Normalize live telemetry into a small internal model.
3. Add authenticated communication with the Sterling API on port 3000.
4. Add job start/completion lifecycle and idempotent submission.
5. Add server-backed job history and staff approval state.
6. Add Windows UI/background behavior.
7. Add installer and GitHub Actions only after the tracker works locally.

## Initial target

- .NET 8
- Windows x64
- Version 3.0.0
- No installer yet
- No CI release workflow yet
- No runtime source patching during builds
