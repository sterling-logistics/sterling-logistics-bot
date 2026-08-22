# Sterling Tracker API v2

Standalone Tracker backend for Host 2. It does not log into Discord as a bot and does not register slash commands.

## Sparked Host 2

Use startup file:

`tracker-api-v2/src/server.js`

The root repository package already provides `express`, `mysql2`, and `dotenv`, so the normal root `npm install --production` is sufficient.

Create `/home/container/.env` with the values shown in `.env.example`. Use the same Discord application ID/client secret and MySQL database as Host 1. Do not add `DISCORD_BOT_TOKEN` to Host 2.

The service exposes:

- `GET /health`
- `POST /auth/desktop/start`
- `GET /auth/desktop/status`
- `GET /auth/discord/callback`
- `POST /auth/desktop/logout`
- `GET /api/desktop/me`
- `GET /api/tracker/jobs`
- `POST /api/tracker/telemetry`

Completed deliveries are written to the existing `jobs` and `tracked_job_approvals` tables so Host 1 can continue handling staff approval and wallet payment.

When Host 2 has an externally reachable allocation, add this exact redirect URI in the Discord Developer Portal:

`http://HOST2_IP:HOST2_PORT/auth/discord/callback`

(or the HTTPS equivalent if a proxy/domain is used).
