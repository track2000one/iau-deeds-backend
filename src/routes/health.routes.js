import { Router } from 'express';

const router = Router();
const startedAt = new Date().toISOString();

export const HEALTH_CAPABILITIES = [
  'accounting_evidence_audit_mirror_v1',
  'accounting_evidence_audit_reconciliation_v1',
  'accounting_evidence_audit_backfill_missing_only_v1',
];

export const getHealthPayload = () => ({
  ok: true,
  service: 'IAU Deeds and Lands API',
  time: new Date().toISOString(),
  startedAt,
  uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
  deployment: {
    commitSha:
      process.env.RAILWAY_GIT_COMMIT_SHA
      || process.env.GIT_COMMIT_SHA
      || process.env.COMMIT_SHA
      || null,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || null,
    serviceName: process.env.RAILWAY_SERVICE_NAME || null,
  },
  capabilities: HEALTH_CAPABILITIES,
});

router.get('/', (_req, res) => {
  res.json(getHealthPayload());
});

export default router;
