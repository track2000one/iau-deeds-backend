import 'dotenv/config';
import { app } from './app.js';
import { ensureBootstrapAdmin } from './bootstrapAdmin.js';
import { ensureAccountingTransformationBaseline } from './services/accountingCycles.service.js';
import { applyAccountingStage6Baseline } from './services/accountingStage6Baseline.service.js';
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

  // The reviewed Stage 6 workbook is the requested accounting baseline. In
  // production we fail closed: if Google Sheets cannot be read or the verified
  // 16 land / 625 building / 11 deed-bearing-land counts do not match, the new
  // deployment must not start with stale accounting-transformation data.
  const stage6 = await applyAccountingStage6Baseline();
  if (stage6.state === 'applied') {
    console.log(`Applied accounting Stage 6 baseline with ${stage6.currentRecords} records.`);
  } else {
    console.log(`Accounting Stage 6 baseline state: ${stage6.state}.`);
  }

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
