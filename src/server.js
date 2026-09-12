import 'dotenv/config';
import { app } from './app.js';
import { ensureBootstrapAdmin } from './bootstrapAdmin.js';
import { ensureAccountingTransformationBaseline } from './services/accountingCycles.service.js';
import { ensureOrganizationStorage } from './services/organization.service.js';
import { ensureOfficialMosqueSites } from './services/mosqueSites.service.js';
import { archiveOrphanedMosqueLeaves } from './services/mosqueLeaveLifecycle.service.js';
import { backfillEvidenceAuditMirror } from './services/accountingEvidenceAudit.service.js';
import { prisma } from './prisma.js';

const port = Number(process.env.PORT || 8080);

const startServer = async () => {
  await ensureBootstrapAdmin();
  await ensureOrganizationStorage();
  await ensureOfficialMosqueSites();
  await archiveOrphanedMosqueLeaves();
  await ensureAccountingTransformationBaseline();
  try {
    const auditBackfill = await backfillEvidenceAuditMirror(prisma);
    if (auditBackfill.mirrored > 0) {
      console.log(`Mirrored ${auditBackfill.mirrored} protected accounting evidence audit events.`);
    }
  } catch (error) {
    console.error('Unable to backfill protected accounting evidence audit events:', error);
  }

  app.listen(port, () => {
    console.log(`IAU Deeds and Lands API is running on port ${port}`);
  });
};

startServer().catch((error) => {
  console.error('Unable to start the API:', error);
  process.exit(1);
});
