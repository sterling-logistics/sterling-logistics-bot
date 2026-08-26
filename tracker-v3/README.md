# Sterling Tracker 3.1

Sterling Logistics' current Windows tracker rewrite, focused on reliable ETS2 / ATS telemetry, TruckersMP compatibility, server-backed jobs and staff-controlled payouts.

## Current baseline

- .NET 8
- Windows x64
- Version 3.1.0
- Direct SCS shared-memory telemetry
- Discord-linked Sterling driver identity
- Sterling API communication with automatic endpoint fallback
- Job start/completion lifecycle with server persistence
- Server-backed job history and approval state
- Automatic payout/profile sync with backups and manual fallback
- Background/tray operation
- Single-instance protection
- Persistent crash diagnostics

## Compatibility target

The compatibility layer is maintained independently from the business logic so game/TMP updates can be handled without rewriting job processing.

Current target family:

- TruckersMP: 0.7.4.x
- ETS2: 1.60.x
- ATS: 1.60.x

Exact supported game builds can move as TruckersMP updates. Sterling Tracker should treat telemetry capability as the source of truth: if the SCS shared-memory channel is healthy, tracking continues; if compatibility breaks, the tracker reports it clearly rather than silently losing jobs.

## Reliability rules

1. Never pay a job directly from the desktop client.
2. Completed work is submitted to Sterling and remains pending until staff approval.
3. MySQL/server records are authoritative for job history and approval state.
4. A job submission must be idempotent so retries cannot create duplicate pay.
5. Telemetry loss must not erase the last valid active-job metadata.
6. Payout sync must back up game saves before modification and retain `/withdraw` as fallback.
7. Tracker crashes are written to `%LOCALAPPDATA%\Sterling Logistics\Tracker\crash.log`.
8. Only one Sterling Tracker process may run per Windows session.

## Next improvements

- Surface detected TruckersMP/game compatibility directly in the UI.
- Add updater/channel metadata so drivers can see when a newer Sterling Tracker is available.
- Add stronger reconnect/offline queue handling for temporary API outages.
- Add richer route, speed-limit, gear, cruise and delivery-quality telemetry where the SDK exposes it reliably.
- Add signed/reproducible Windows release automation only after each build passes an end-to-end delivery test.
