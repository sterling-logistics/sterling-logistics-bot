# Sterling Logistics Windows Live Tracker (MVP)

This is the fastest deployment path for ETS2 drivers.

## Driver requirements

1. Euro Truck Simulator 2 on Windows x64.
2. RenCloud SCS telemetry plug-in v1.12.1 installed as `scs-telemetry.dll` in the ETS2 `bin/win_x64/plugins` folder.
3. Telemetry JSON Service running locally. Its default endpoint is `http://localhost:6969/`.
4. A Sterling driver profile in Discord.
5. A private tracker key generated with `/trackerkey`.

## Run

Open PowerShell in this folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\SterlingTracker.ps1 -ApiBase "https://YOUR-PUBLIC-BOT-URL" -TrackerKey "YOUR_TRACKER_KEY"
```

Keep the tracker window open while driving.

## What it sends

Every 10 seconds it sends a heartbeat to `/api/tracker/telemetry`, including the raw telemetry JSON plus normalized game, speed, truck, cargo, source, destination, distance and revenue fields when available.

The bot stores live data in MySQL and `/companylive` displays currently active drivers. When a job transition is detected, `job-started` / `job-delivered` events are recorded. Completed job distance is converted from kilometres to miles and added to the driver's totals.

## Important

The tracker key is private. Do not post it publicly. Running `/trackerkey` again invalidates the old key.

The bot API must be reachable from the public internet. ApolloPanel port 3000 therefore needs either a public allocation or a reverse-proxied HTTPS domain.
