import { Router } from 'express';
import { prisma } from '../prisma.js';
import { downloadGoogleDriveFile } from '../services/googleDrive.js';
import { ensureAccountingTransformationBaseline } from '../services/accountingCycles.service.js';
import {
  attachCurrentAccountingTemplateToOpenCycles,
  decorateCyclesWithTemplateSnapshot,
  getCycleTemplateSnapshot,
} from '../services/accountingTemplateVersions.service.js';

const router = Router();
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const serializeCycle = (cycle) => ({
  ...cycle,
  recordCount: cycle._count?.records ?? cycle.recordCount ?? 0,
  _count: undefined,
});

router.get('/', async (_req, res, next) => {
  try {
    await ensureAccountingTransformationBaseline();
    let cycles = await prisma.accountingTransformationCycle.findMany({
      orderBy: [{ cycleNumber: 'desc' }],
      include: { _count: { select: { records: true } } },
    });
    await attachCurrentAccountingTemplateToOpenCycles(cycles.filter((cycle) => ['draft', 'under_review'].includes(cycle.status)));
    cycles = await decorateCyclesWithTemplateSnapshot(cycles);
    res.json(cycles.map(serializeCycle));
  } catch (error) { next(error); }
});

router.get('/current', async (_req, res, next) => {
  try {
    const current = await ensureAccountingTransformationBaseline();
    const cycle = await prisma.accountingTransformationCycle.findUnique({
      where: { id: current.id },
      include: { _count: { select: { records: true } } },
    });
    const [decorated] = await decorateCyclesWithTemplateSnapshot([cycle]);
    res.json(serializeCycle(decorated));
  } catch (error) { next(error); }
});

const getCycle = async (id) => prisma.accountingTransformationCycle.findUnique({ where: { id } });

router.get('/:id/template', async (req, res, next) => {
  try {
    const cycle = await getCycle(req.params.id);
    if (!cycle) return res.status(404).json({ message: 'دورة التحديث غير موجودة' });
    const snapshot = await getCycleTemplateSnapshot(cycle, { attachForOpenCycle: true });
    res.json(snapshot || null);
  } catch (error) { next(error); }
});

router.get('/:id/template/file', async (req, res, next) => {
  try {
    const cycle = await getCycle(req.params.id);
    if (!cycle) return res.status(404).json({ message: 'دورة التحديث غير موجودة' });
    const snapshot = await getCycleTemplateSnapshot(cycle, { attachForOpenCycle: true });
    if (!snapshot) return res.status(404).json({ message: 'لا توجد نسخة نموذج رسمي مثبتة على هذه الدورة.' });
    const downloaded = await downloadGoogleDriveFile(snapshot.driveFileId);
    const safeName = String(snapshot.fileName || downloaded.fileName || `cycle-${cycle.cycleNumber}-template.xlsx`).replace(/[\"\r\n]/g, '_');
    res.setHeader('Content-Type', EXCEL_MIME);
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(safeName));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(downloaded.buffer);
  } catch (error) { next(error); }
});

export default router;
