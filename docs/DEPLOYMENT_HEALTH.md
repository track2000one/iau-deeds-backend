# Deployment health fingerprint

`GET /api/health` remains public and now exposes a non-sensitive deployment fingerprint used for operational verification after deployment.

It includes:
- current server time and process start time;
- uptime in seconds;
- deployment commit SHA when provided by the hosting environment;
- deployment/environment/service identifiers when provided by Railway;
- explicit backend capabilities for the protected accounting evidence audit flow.

No secrets, credentials, database URLs, tokens, or user data are exposed.

The frontend can use the capabilities list to confirm that the deployed backend supports the evidence AuditLog mirror, server reconciliation, and missing-only backfill before an administrator runs the live database check.
