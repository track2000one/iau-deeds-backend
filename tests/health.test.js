import test from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_CAPABILITIES, getHealthPayload } from '../src/routes/health.routes.js';

test('health payload exposes deployment fingerprint without secrets', () => {
  const payload = getHealthPayload();

  assert.equal(payload.ok, true);
  assert.equal(payload.service, 'IAU Deeds and Lands API');
  assert.ok(Array.isArray(payload.capabilities));
  assert.ok(payload.capabilities.includes('accounting_evidence_audit_reconciliation_v1'));
  assert.ok(payload.capabilities.includes('accounting_evidence_audit_backfill_missing_only_v1'));
  assert.ok(payload.capabilities.includes('accounting_stage6_baseline_v1'));
  assert.equal(typeof payload.uptimeSeconds, 'number');
  assert.ok(payload.deployment && typeof payload.deployment === 'object');
  assert.ok(Object.prototype.hasOwnProperty.call(payload.deployment, 'commitSha'));
  assert.ok(Object.prototype.hasOwnProperty.call(payload.deployment, 'environment'));
  assert.ok(payload.accountingStage6Baseline && typeof payload.accountingStage6Baseline === 'object');
  assert.equal(payload.accountingStage6Baseline.source.expected.land, 16);
  assert.equal(payload.accountingStage6Baseline.source.expected.building, 625);
  assert.equal(payload.accountingStage6Baseline.source.expected.deedBearingLand, 11);
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'databaseUrl'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'token'));
});

test('health capabilities are stable and explicit', () => {
  assert.deepEqual(HEALTH_CAPABILITIES, [
    'accounting_evidence_audit_mirror_v1',
    'accounting_evidence_audit_reconciliation_v1',
    'accounting_evidence_audit_backfill_missing_only_v1',
    'accounting_stage6_baseline_v1',
  ]);
});
