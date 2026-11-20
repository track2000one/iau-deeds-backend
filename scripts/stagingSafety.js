// Isolated QA-only startup guard. This file is not imported by production.
// Forbids touching the university production project or any public database host.
export const STAGING_PROJECT_ID = 'b30063fd-d79a-4edb-aef3-678dde1a9bfc';
export const STAGING_ENVIRONMENT_ID = '1801e6db-8902-4d64-8385-155911934cc5';

export const validateStagingConfiguration = (env = process.env) => {
  if (env.IAU_STAGING_MODE !== 'synthetic-only') {
    throw new Error('Staging start refused: synthetic-only mode is required.');
  }
  if (env.RAILWAY_PROJECT_ID !== STAGING_PROJECT_ID ||
      env.RAILWAY_ENVIRONMENT_ID !== STAGING_ENVIRONMENT_ID) {
    throw new Error('Staging start refused: Railway project/environment identity does not match the isolated QA project.');
  }
  if (env.RAILWAY_SERVICE_NAME !== 'iau-deeds-backend-staging') {
    throw new Error('Staging start refused: unexpected Railway service name.');
  }
  if (!env.DATABASE_URL) {
    throw new Error('Staging start refused: DATABASE_URL is missing.');
  }
  let database;
  try {
    database = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('Staging start refused: database URL cannot be parsed.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.hostname.toLowerCase() !== 'postgres.railway.internal' ||
      database.port !== '5432' ||
      database.pathname !== '/railway' ||
      database.username.toLowerCase() !== 'postgres') {
    throw new Error('Staging start refused: database must be the private dedicated PostgreSQL service.');
  }
  if ((env.JWT_SECRET || '').length < 32) {
    throw new Error('Staging start refused: JWT_SECRET must be at least 32 characters.');
  }
  if (!/^[^@\s]+@[^@\s]+\.invalid$/.test(env.BOOTSTRAP_ADMIN_EMAIL || '')) {
    throw new Error('Staging start refused: bootstrap admin must use a non-deliverable .invalid email.');
  }
  if ((env.BOOTSTRAP_ADMIN_PASSWORD || '').length < 16) {
    throw new Error('Staging start refused: bootstrap password must be at least 16 characters.');
  }
  const prohibited = [
    'BREVO_API_KEY', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN',
    'OPENAI_API_KEY', 'SMTP', 'DATABASE_PUBLIC_URL',
  ];
  const present = prohibited.filter((key) => Boolean((env[key] || '').trim()));
  if (present.length) {
    throw new Error('Staging start refused: production-capable integrations must be absent: ' + present.join(', '));
  }
  return { databaseHost: database.hostname, project: STAGING_PROJECT_ID, environment: STAGING_ENVIRONMENT_ID };
};
