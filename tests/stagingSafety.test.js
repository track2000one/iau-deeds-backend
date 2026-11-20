import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStagingConfiguration, STAGING_PROJECT_ID, STAGING_ENVIRONMENT_ID,
} from '../scripts/stagingSafety.js';

const baseline = {
  RAILWAY_PROJECT_ID: STAGING_PROJECT_ID,
  RAILWAY_ENVIRONMENT_ID: STAGING_ENVIRONMENT_ID,
  RAILWAY_SERVICE_NAME: 'iau-deeds-backend-staging',
  IAU_STAGING_MODE: 'synthetic-only',
  DATABASE_URL: 'postgresql://postgres:example@postgres.railway.internal:5432/railway',
  JWT_SECRET: 'a-long-test-value-with-at-least-32-chars',
  BOOTSTRAP_ADMIN_EMAIL: 'qa-admin@iau-staging.invalid',
  BOOTSTRAP_ADMIN_PASSWORD: 'only-an-example-passphrase-123',
};

test('accepts explicit synthetic isolated staging configuration', () => {
  assert.equal(validateStagingConfiguration(baseline).project, STAGING_PROJECT_ID);
});
test('rejects production project or environment', () => {
  assert.throws(() => validateStagingConfiguration({ ...baseline, RAILWAY_PROJECT_ID: 'production-id' }), /identity/);
  assert.throws(() => validateStagingConfiguration({ ...baseline, RAILWAY_ENVIRONMENT_ID: 'production-id' }), /identity/);
});
test('rejects any unexpected service or database location', () => {
  assert.throws(() => validateStagingConfiguration({ ...baseline, RAILWAY_SERVICE_NAME: 'iau-deeds-backend' }), /service name/);
  for (const hostname of ['Postgres-iau-deeds-backend.railway.internal', 'localhost', 'production.example.com']) {
    assert.throws(() => validateStagingConfiguration({
      ...baseline, DATABASE_URL: 'postgresql://postgres:example@' + hostname + ':5432/railway',
    }), /private dedicated/);
  }
  assert.throws(() => validateStagingConfiguration({ ...baseline, DATABASE_URL: 'not-a-url' }), /cannot be parsed/);
});
test('rejects missing JWT or weak/admin deliverable credentials', () => {
  assert.throws(() => validateStagingConfiguration({ ...baseline, JWT_SECRET: '' }), /JWT_SECRET/);
  assert.throws(() => validateStagingConfiguration({ ...baseline, BOOTSTRAP_ADMIN_EMAIL: 'admin@iau.edu.sa' }), /invalid email/);
  assert.throws(() => validateStagingConfiguration({ ...baseline, BOOTSTRAP_ADMIN_PASSWORD: 'weak' }), /password/);
});
test('rejects external services and missing synthetic-only opt-in', () => {
  assert.throws(() => validateStagingConfiguration({ ...baseline, IAU_STAGING_MODE: 'production' }), /synthetic-only/);
  for (const key of ['BREVO_API_KEY', 'GOOGLE_OAUTH_REFRESH_TOKEN', 'OPENAI_API_KEY', 'DATABASE_PUBLIC_URL']) {
    assert.throws(() => validateStagingConfiguration({ ...baseline, [key]: 'nonempty' }), /integrations/);
  }
});
