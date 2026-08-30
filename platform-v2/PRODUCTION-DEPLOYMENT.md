# Sterling Platform V2 — Production Deployment Runbook

This runbook is the required deployment order for Sterling Platform V2. Do not skip the validation gates.

## 1. Production environment

Required environment variables:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=<assigned panel port>`
- `DATABASE_URL=mysql://...`
- `JWT_ACCESS_SECRET=<strong random secret, 32+ characters>`
- `JWT_REFRESH_SECRET=<different strong random secret, 32+ characters>`
- `ACCESS_TOKEN_TTL=15m`
- `REFRESH_TOKEN_DAYS=30`

Never commit real production secrets to GitHub.

## 2. Database migration gate

From `platform-v2` run:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run migrate
npm run migrate
```

The second migration run must report every migration as `SKIP`. This proves migrations are repeatable and that no already-applied migration has been modified.

## 3. Owner bootstrap

Only on a fresh Platform V2 database with no Owner account:

```bash
STERLING_OWNER_USERNAME='...' \
STERLING_OWNER_PASSWORD='...' \
STERLING_OWNER_DISPLAY_NAME='Owner / Founder' \
npm run bootstrap:owner
```

Bootstrap refuses to overwrite an existing Owner account.

## 4. Start production API

```bash
npm start
```

The public reverse proxy/canonical Sterling hostname must terminate HTTPS and forward only to the assigned V2 API port.

## 5. Readiness gates

The following must all pass before Windows clients are pointed at production:

1. `GET /api/v2/health` returns HTTP 200 with `status=ok` and `database=up`.
2. An unauthenticated request to `/api/v2/owner/system` returns HTTP 401.
3. Owner login succeeds and returns role `owner`.
4. Authenticated `/api/v2/owner/system` returns API and database `online`.
5. The production smoke script passes:

```bash
STERLING_SMOKE_URL='https://<canonical-host>' \
STERLING_OWNER_USERNAME='...' \
STERLING_OWNER_PASSWORD='...' \
node scripts/production-smoke.mjs
```

Expected final line: `STERLING PRODUCTION SMOKE: PASS`.

## 6. Windows client validation

Install the generated Sterling Tachograph V2 and Sterling Control Centre V2 packages on a Windows test PC. Confirm the Tachograph installer places the SCS telemetry plugin into detected ETS2/ATS `bin/win_x64/plugins` directories.

Then perform two separate road tests: one ETS2 and one ATS.

Required workflow for each game:

`login -> game detected -> telemetry live -> driver online in Control Centre -> assigned job -> job starts -> live location/speed/job data updates -> delivery detected -> server submission -> normal-driver approval OR Owner auto-approval -> payout claimed -> save backup -> balance changed once -> payout verified -> job remains in history`

A failed or incomplete step blocks production release.

## 7. Release rule

Do not publish Platform V2 as production-ready until:

- Backend CI is green including MySQL migration and production smoke gates.
- Windows CI is green including both installers.
- ETS2 road test passes.
- ATS road test passes.
- Duplicate submission and duplicate payout tests show no duplicate payment.
- Network-loss/restart recovery is verified during a payout test.

Keep the legacy system available as rollback/reference until Platform V2 completes the full production acceptance test.
