import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import { deleteGoogleDriveFile, downloadGoogleDriveFile, uploadBufferToGoogleDrive } from '../services/googleDrive.js';
import { ensureAccountingTransformationBaseline } from '../services/accountingCycles.service.js';
import {
  OFFICIAL_ACCOUNTING_TEMPLATE_KEY,
  attachCurrentAccountingTemplateToOpenCycles,
  decorateCyclesWithTemplateSnapshot,
  getCurrentAccountingTemplateWithVersion,
  getCycleTemplateSnapshot,
} from '../services/accountingTemplateVersions.service.js';

const router = Router();
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    const allowed = file.mimetype === EXCEL_MIME || fileName.endsWith('.xlsx');
    cb(allowed ? null : new Error('الإصدار الجديد يجب أن يكون ملف Excel بصيغة XLSX.'), allowed);
  },
});

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

router.post('/:id/template/new-version', upload.single('file'), async (req, res, next) => {
  let uploaded = null;
  try {
    if (req.authUser?.role !== 'admin') return res.status(403).json({ message: 'رفع إصدار جديد من النموذج الرسمي متاح لمسؤول النظام فقط.' });
    const cycle = await getCycle(req.params.id);
    if (!cycle) return res.status(404).json({ message: 'دورة التحديث غير موجودة' });
    if (!['draft', 'under_review'].includes(cycle.status)) {
      return res.status(409).json({ message: 'لا يمكن تغيير نسخة النموذج لدورة معتمدة أو مؤرشفة. النسخة التاريخية لهذه الدورة مقفلة.' });
    }
    if (!req.file) return res.status(400).json({ message: 'لم يتم إرفاق ملف Excel للإصدار الجديد.' });

    const current = await getCurrentAccountingTemplateWithVersion();
    uploaded = await uploadBufferToGoogleDrive(req.file, {
      fileName: `official-accounting-transformation-template-${Date.now()}.xlsx`,
      mimeType: EXCEL_MIME,
    });
    const uploadedBy = req.authUser?.email || req.authUser?.username || null;
    const nextVersion = current ? Number(current.versionNumber || 1) + 1 : 1;

    const result = await prisma.$transaction(async (tx) => {
      if (current) {
        await tx.assetExcelTemplate.update({
          where: { id: current.id },
          data: {
            templateKey: `${OFFICIAL_ACCOUNTING_TEMPLATE_KEY}:v${current.versionNumber}`,
            title: `نموذج التحول المحاسبي الرسمي — الإصدار ${current.versionNumber}`,
          },
        });
      }

      const template = await tx.assetExcelTemplate.create({
        data: {
          templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY,
          title: `نموذج التحول المحاسبي الرسمي المعتمد — الإصدار ${nextVersion}`,
          fileName: req.file.originalname || uploaded.fileName,
          driveFileId: uploaded.driveFileId,
          driveUrl: uploaded.driveUrl,
          mimeType: uploaded.mimeType || EXCEL_MIME,
          fileSize: req.file.size || null,
          uploadedBy,
        },
      });

      const snapshot = await tx.accountingCycleTemplateSnapshot.upsert({
        where: { cycleId: cycle.id },
        update: {
          templateId: template.id,
          fileName: template.fileName,
          versionNumber: nextVersion,
          driveFileId: template.driveFileId,
          attachedAt: new Date(),
        },
        create: {
          cycleId: cycle.id,
          templateId: template.id,
          fileName: template.fileName,
          versionNumber: nextVersion,
          driveFileId: template.driveFileId,
          attachedAt: new Date(),
        },
      });
      return { template, snapshot };
    });

    const response = {
      template: { ...result.template, versionNumber: nextVersion, isCurrent: true },
      snapshot: result.snapshot,
    };
    await createAuditLog({
      user: req.authUser,
      action: 'create_version',
      module: 'accounting_transformation',
      entity: 'accounting_cycle_template',
      entityId: cycle.id,
      entityLabel: `الدورة #${cycle.cycleNumber} — ${cycle.name}`,
      description: `رفع الإصدار ${nextVersion} من النموذج الرسمي وتثبيته على الدورة #${cycle.cycleNumber}`,
      previousData: await prisma.accountingCycleTemplateSnapshot.findUnique({ where: { cycleId: cycle.id } }),
      newData: response,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json(response);
  } catch (error) {
    if (uploaded?.driveFileId) deleteGoogleDriveFile(uploaded.driveFileId).catch(() => {});
    next(error);
  }
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

// Let the legacy delete handler remove the cycle itself, but clean the detached
// snapshot first only when the cycle is actually eligible for deletion.
router.delete('/:id', async (req, _res, next) => {
  try {
    const cycle = await getCycle(req.params.id);
    if (cycle && !cycle.isCurrent && ['draft', 'under_review'].includes(cycle.status)) {
      await prisma.accountingCycleTemplateSnapshot.deleteMany({ where: { cycleId: cycle.id } });
    }
    next();
  } catch (error) { next(error); }
});

export default router;