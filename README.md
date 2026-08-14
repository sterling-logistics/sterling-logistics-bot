# Sterling Logistics Bot — Sparked Host / MySQL v3

Built for Sparked Host with Node.js 22+ and MySQL.

## Included now
Verification, support tickets, claim/info/add/remove/rename/transcript/close,
stale-ticket repair, orphan cleanup, reviews, driver profiles, recruitment,
permanent Sterling Driver IDs, HR case records, LOA requests, training records,
convoy creation, job history, live-fleet command, and MySQL tables for
promotions, attendance, achievements, jobs, tracker tokens, telemetry events
and audit logs.

## Live ETS2
The hosted backend includes `POST /api/telemetry`, but the actual Windows
Sterling Tracker is still required on each driver's PC to read SCS/ETS2
telemetry and send it securely to the server.

## Start
1. Fill environment variables from `.env.example`
2. `npm install`
3. `npm run check`
4. `npm start`
