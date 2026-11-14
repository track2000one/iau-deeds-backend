# Stage 12 — API operational monitoring

## Data and access
- **Admin only:** `GET /api/audit/monitoring` runs under the existing `requireAuth` + `requireAdmin` guard on `/api/audit`.
- **Current 15-minute process window:** exact counts in the currently running Node.js process for HTTP 2xx/3xx, 4xx, invalid sessions (401), forbidden operations (403), server errors (5xx), responses exceeding 2,000 ms and average response duration. Counters and the last 80 sanitized incident summaries are **in memory**; a restart/deploy resets them. They are not service-wide when multiple instances are running.
- **Last 24 hours from existing PostgreSQL AuditLog:** sampled 401/403 events and each observed 5xx response, plus 25 recent event records. This is a *sample*, not the exact number of failed requests. The frontend labels it accordingly.
- Recording excludes `/api/health` and the administrative `/api/audit` route to avoid health-check noise and monitoring recursion.
- Access-denied/login-denied audit writes are suppressed to at most one per minute per salted hashed origin/user/module/event. Raw request bodies, URLs, query strings, credentials, cookies and tokens are never persisted by monitoring middleware.
- The HTTP logger prints only method, module, response code and response duration—not record IDs or query strings.
- Unexpected server errors return a generic user message plus a randomly generated `requestId`, which is also sent as an `X-Request-ID` header; the same ID appears in the sanitized audit event metadata. The error message itself is not exposed.
- Existing administrative audit reports continue to work; monitoring introduces no database/schema migration.

## Tests
- `npm test`: bound counters, time window expiry, event sampling, privacy, safe 500 responses and request IDs.
- `FOLLOW_UP_INTEGRATION_TEST=1` with the GitHub Actions ephemeral PostgreSQL environment: test 401/403 for unauthorized monitoring readers and 200 for an administrator; verify private fields are absent.
- CI never queries Railway production.

## Operational interpretation
If 5xx spikes or slow requests rise, correlate `requestId` from the user error with the monitoring record and Railway logs. Check a specific service's deployment state before assuming all replicas are healthy.

**Limits:** This is historical and on-demand visibility, not a 24/7 alerting service, SLA monitor, distributed trace system, or permanent unthrottled security log. Multiple replicas each maintain their own in-memory counters. For proactive notifications, add an external alerting service or scheduled monitor as a separate scoped task.
