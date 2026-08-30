# Sterling Platform 2.0 — Architecture Standard

## Goal
Build Sterling as a professional VTC operations platform, not a collection of loosely connected tools. The platform must be reliable, secure, auditable, visually consistent, and easy for drivers and staff to use.

## Core architecture
- One backend API owns all business rules.
- One relational database is the source of truth.
- Tracker, Dispatch, Website and Discord Bot are clients of the same API.
- No client is allowed to calculate official pay, promote drivers, approve work or mutate protected records without server authorization.
- Every important action creates an audit record.

## Identity and access
- Staff create driver accounts with username, temporary password, display name, driver ID, role and status.
- Passwords are stored using a modern password hash with per-user salt.
- Sessions use short-lived access tokens plus revocable refresh sessions.
- Accounts can be enabled, suspended, locked or archived.
- Password reset invalidates existing sessions.
- Roles are server-side and permission based, not UI based.
- Administrative actions require explicit permissions.
- Login attempts are rate limited and recorded.

## Driver experience
- Professional branded login screen.
- Remembered secure session.
- Dashboard with driver name, ID, rank, status, earnings, recent jobs and current connection state.
- Clear ETS2 / ATS telemetry status.
- Automatic job detection and submission.
- Offline-safe queue so a temporary API outage does not lose a completed job.
- Visible submission state: recording, submitting, submitted, approved, declined, paid.
- Full personal job history.
- No staff controls in the driver client.

## Job lifecycle
`assigned -> in_progress -> submitted -> approved | declined -> paid`

Rules:
- A job has one permanent unique ID.
- State transitions are validated by the API.
- Completed/submitted records are never silently deleted.
- Duplicate telemetry submission is idempotent and returns the existing job.
- Approval can only happen once.
- Payout can only happen once.
- Corrections are represented by new audit events, never by erasing history.

## Dispatch / staff experience
- Searchable driver directory with availability and account state.
- Create assignments using controlled cargo and location catalogues.
- Active, submitted, completed, declined and cancelled history remains visible.
- Approval queue with all delivery evidence in one view.
- Payout monitor with retry/error state.
- Driver account creation, disable, unlock and password reset.
- Role and permission administration.
- Audit log searchable by actor, driver, job, action and date.

## Reliability requirements
- Database transactions around approval and payout operations.
- Unique constraints protect against duplicate jobs and duplicate payouts.
- Idempotency keys for telemetry and other retryable writes.
- API health and readiness endpoints.
- Structured application logs with request/job/user correlation IDs.
- Graceful client retry with exponential backoff.
- Database migration system with reversible migrations where practical.
- Daily backups and documented restore process before production cutover.

## Security requirements
- TLS only in production.
- Passwords and session tokens never logged.
- Secrets only from environment/secret storage.
- Input validation on every write endpoint.
- Parameterized database queries.
- Principle of least privilege for DB and staff roles.
- Account lock/rate limiting for repeated login failures.
- Server-side authorization on every protected route.
- Audit events cannot be modified through normal application endpoints.

## API structure
- `/api/v2/auth/*` — login, refresh, logout, current session.
- `/api/v2/drivers/*` — driver profiles and account administration.
- `/api/v2/jobs/*` — job creation, telemetry submission, history and state.
- `/api/v2/dispatch/*` — assignments and catalogues.
- `/api/v2/approvals/*` — review queue and decisions.
- `/api/v2/payouts/*` — payout state and retry tools.
- `/api/v2/audit/*` — authorized audit search.
- `/api/v2/health` and `/api/v2/ready` — service health.

## Desktop design standard
- Consistent Sterling design system across Tracker and Dispatch.
- Modern spacing, typography and hierarchy.
- Dark/light capable component palette.
- No default WinForms-looking layouts in the finished product.
- Clear status chips, cards, data grids and empty/error/loading states.
- Responsive window behaviour and DPI scaling.
- Keyboard navigation and accessible contrast.
- Loading actions never freeze the UI thread.
- User-facing errors are short and useful; technical diagnostics go to logs.

## Quality gates
A feature is not complete until:
1. Server-side validation exists.
2. Authorization is tested.
3. Success path is tested.
4. Failure/retry path is tested.
5. Duplicate request behaviour is tested.
6. UI loading, empty and error states exist.
7. Audit behaviour is verified where applicable.
8. CI is green.

## Release rule
No build is called production-ready because it compiles or looks good. A release must pass an end-to-end test covering login -> drive/assignment -> telemetry submission -> approval -> payout -> permanent history.
