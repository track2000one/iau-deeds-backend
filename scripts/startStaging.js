import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { validateStagingConfiguration } from './stagingSafety.js';

// Validate before loading any database models, writing schema, creating an admin, or running timers.
validateStagingConfiguration();

console.log('IAU-DEEDS QA staging: initializing isolated synthetic PostgreSQL schema.');
// No --accept-data-loss: Prisma must refuse destructive schema changes.
execFileSync('npx', ['prisma', 'db', 'push'], { stdio: 'inherit', env: process.env });

const { app } = await import('../src/app.js');
const { ensureBootstrapAdmin } = await import('../src/bootstrapAdmin.js');

// Only the non-deliverable test admin is created. Avoid production server.js startup
// jobs, external email, Drive sync, accounting import, and scheduled backups.
await ensureBootstrapAdmin();

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log('IAU-DEEDS isolated QA API is listening on port ' + port);
});
