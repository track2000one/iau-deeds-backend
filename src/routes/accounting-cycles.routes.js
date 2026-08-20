import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import {
  buildAccountingSnapshotData,
  createAccountingFingerprint,
  createAccountingStableKey,
  ensureAccountingTransformationBaseline,
  getAccountingCycleComparison,
  nextAccountingRecordNumber,
} from '../services/accountingCycles.service.js';
import { hasAccountingValue } from '../config/accountingTransformation.js';

const router = Router();

const attachmentSchema = z.object({
  title: z.string().trim().min(1),
  driveUrl: z.string().trim().min(1),
  driveFileId: z.string().trim().nullable().optional(),
  mimeType: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
});

const recordInputSchema = z.object({
  recordType: z.enum(['land', 'building']),
  ownershipMode: z.enum(['owned', 'leased', 'other']).optional(),
  committeeStatus: z.enum(['not_reviewed', 'under_review', 'needs_update', 'approved', 'completed']).default('not_reviewed'),
  payload: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(attachmentSchema).default([]),
  notes: z.string().trim().nullable().optional(),
});

const cycleInputSchema = z.object({
  name: z.string().trim().min(3, 'اسم دورة التحديث مطلوب').max(160),
  description: z.string().trim().max(1200).nullable().optional(),
});

const importSchema = z.object({
  items: z.array(recordInputSchema).min(1).max(10000),
  fileName: z.string().trim().max(255).nullable().optional(),
});

const userLabel = (req) => req.authUser?.email || req.authUser?.username || null;
const accountingPermission = (req) => req.authUser?.permissions?.find((item) => item.module === 'accounting_transformation');
const canEditCycles = (req) => req.authUser?.role === 'admin' || Boolean(accountingPermission(req)?.canEdit);
const canApproveCycles = (req) => req.authUser?.role === 'admin' || Boolean(accountingPermission(req)?.canApproveCycle);

const serializeCycle = (cycle, comparison = null) => ({
  ...cycle,
  recordCount: cycle._count?.records ?? cycle.recordCount ?? 0,
  _count: undefined,
  comparison,
});

const getCycleOr404 = async (req, res) => {
  const cycle = await prisma.accountingTransformationCycle.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { records: true } } },
  });
  if (!cycle) {
    res.status(404).json({ message: 'دورة التحديث غير موجودة' });
    return null;
  }
  return cycle;
};

const assertDraftCycle = (cycle, res) => {
  if (cycle.status !== 'draft' || cycle.isCurrent) {
    res.status(409).json({
      message:
        cycle.status === 'under_review'
          ? 'الدورة تحت المراجعة ومجمّدة. أعدها إلى المسودة قبل تعديل بياناتها.'
          : 'لا يمكن تعديل هذه الدورة بعد اعتمادها أو أرشفتها',
    });
    return false;
  }
  return true;
};

const itemIsValid = (item) => {
  const payload = item.payload || {};
  return hasAccountingValue(payload.B) || hasAccountingValue(payload.E) || hasAccountingValue(payload.G);
};

const carryForwardUnchangedAccountingRecords = async (cycle) => {
  if (!cycle.basedOnCycleId) return 0;
  const [baseRecords, targetRecords] = await Promise.all([
    prisma.accountingTransformationRecord.findMany({ where: { cycleId: cycle.basedOnCycleId } }),
    prisma.accountingTransformationRecord.findMany({ where: { cycleId: cycle.id }, select: { stableKey: true } }),
  ]);
  const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));
  const missing = baseRecords.filter((record) => record.stableKey && !targetKeys.has(record.stableKey));
  if (!missing.length) return 0;

  const baseNumber = await nextAccountingRecordNumber();
  const baseSequence = Number(baseNumber.split('-').pop()) || 1;
  const year = new Date().getFullYear();
  const rows = missing.map((record, index) => {
    const { id, recordNumber, cycleId: _cycleId, createdAt, updatedAt, ...rest } = record;
    return {
      ...rest,
      cycleId: cycle.id,
      recordNumber: 'ACT-' + year + '-' + String(baseSequence + index).padStart(6, '0'),
      changeType: 'unchanged',
      previousRecordId: id,
    };
  });
  for (let index = 0; index < rows.length; index += 750) {
    await prisma.accountingTransformationRecord.createMany({ data: rows.slice(index, index + 750) });
  }
  return rows.length;
};

router.get('/', async (_req, res, next) => {
  try {
    await ensureAccountingTransformationBaseline();
    const cycles = await prisma.accountingTransformationCycle.findMany({
      orderBy: [{ cycleNumber: 'desc' }],
      include: { _count: { select: { records: true } } },
    });
    res.json(cycles.map((cycle) => serializeCycle(cycle)));
  } catch (error) {
    next(error);
  }
});

router.get('/current', async (_req, res, next) => {
  try {
    const current = await ensureAccountingTransformationBaseline();
    const cycle = await prisma.accountingTransformationCycle.findUnique({
      where: { id: current.id },
      include: { _count: { select: { records: true } } },
    });
    res.json(serializeCycle(cycle));
  } catch (error) {
    next(error);
  }
});

router.get('/:id/comparison', async (req, res, next) => {
  try {
    const cycle = await getCycleOr404(req, res);
    if (!cycle) return;
    res.json(await getAccountingCycleComparison(cycle));
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = cycleInputSchema.parse(req.body);
    const current = await ensureAccountingTransformationBaseline();
    const openCycle = await prisma.accountingTransformationCycle.findFirst({
      where: { status: { in: ['draft', 'under_review'] } },
      orderBy: { cycleNumber: 'desc' },
    });
    if (openCycle) {
      return res.status(409).json({
        message: `توجد دورة تحديث مفتوحة بالفعل: ${openCycle.name}. أكملها أو احذفها قبل إنشاء دورة جديدة.`,
        cycleId: openCycle.id,
      });
    }

    const max = await prisma.accountingTransformationCycle.aggregate({ _max: { cycleNumber: true } });
    const cycle = await prisma.accountingTransformationCycle.create({
      data: {
        cycleNumber: Number(max._max.cycleNumber || 0) + 1,
        name: input.name,
        description: input.description || null,
        status: 'draft',
        isCurrent: false,
        basedOnCycleId: current.id,
        createdBy: userLabel(req),
      },
      include: { _count: { select: { records: true } } },
    });

    await createAuditLog({
      user: req.authUser,
      action: 'create_cycle',
      module: 'accounting_transformation',
      entity: 'accounting_cycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      description: 'إنشاء دورة تحديث جديدة لبيانات التحول المحاسبي',
      newData: cycle,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json(serializeCycle(cycle));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/import-preview', async (req, res, next) => {
  try {
    const input = importSchema.parse(req.body);
    const cycle = await getCycleOr404(req, res);
    if (!cycle || !assertDraftCycle(cycle, res)) return;

    const baseRecords = cycle.basedOnCycleId
      ? await prisma.accountingTransformationRecord.findMany({
          where: { cycleId: cycle.basedOnCycleId },
          select: { stableKey: true, sourceFingerprint: true },
        })
      : [];
    const targetRecords = await prisma.accountingTransformationRecord.findMany({
      where: { cycleId: cycle.id },
      select: { stableKey: true },
    });

    const baseByKey = new Map(baseRecords.filter((item) => item.stableKey).map((item) => [item.stableKey, item]));
    const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));
    const seen = new Set();
    const fileKeys = new Set();
    const invalidIndexes = [];
    const duplicateIndexes = [];
    const freshIndexes = [];
    const newIndexes = [];
    const modifiedIndexes = [];
    const unchangedIndexes = [];

    input.items.forEach((item, index) => {
      if (!itemIsValid(item)) {
        invalidIndexes.push(index);
        return;
      }
      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});
      const fingerprint = createAccountingFingerprint(item.recordType, item.payload || {});

      // A key present anywhere in the uploaded file must count as present when
      // calculating removed records, even if that row was imported in an earlier batch.
      fileKeys.add(stableKey);

      if (seen.has(stableKey)) {
        duplicateIndexes.push(index);
        return;
      }
      seen.add(stableKey);

      // Change classification describes the complete uploaded version and must
      // remain stable even after one or more batches have already been saved.
      const previous = baseByKey.get(stableKey);
      if (!previous) newIndexes.push(index);
      else if (previous.sourceFingerprint === fingerprint) unchangedIndexes.push(index);
      else modifiedIndexes.push(index);

      if (targetKeys.has(stableKey)) {
        duplicateIndexes.push(index);
        return;
      }
      freshIndexes.push(index);
    });

    const removed = baseRecords.filter((item) => item.stableKey && !fileKeys.has(item.stableKey)).length;

    res.json({
      total: input.items.length,
      fresh: freshIndexes.length,
      duplicate: duplicateIndexes.length,
      invalid: invalidIndexes.length,
      freshIndexes,
      duplicateIndexes,
      invalidIndexes,
      new: newIndexes.length,
      modified: modifiedIndexes.length,
      unchanged: unchangedIndexes.length,
      removed: 0,
      notSupplied: removed,
      newIndexes,
      modifiedIndexes,
      unchangedIndexes,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/import', async (req, res, next) => {
  try {
    const input = importSchema.parse(req.body);
    const cycle = await getCycleOr404(req, res);
    if (!cycle || !assertDraftCycle(cycle, res)) return;

    const baseRecords = cycle.basedOnCycleId
      ? await prisma.accountingTransformationRecord.findMany({
          where: { cycleId: cycle.basedOnCycleId },
          select: { id: true, stableKey: true, sourceFingerprint: true },
        })
      : [];
    const baseByKey = new Map(baseRecords.filter((item) => item.stableKey).map((item) => [item.stableKey, item]));
    const targetRecords = await prisma.accountingTransformationRecord.findMany({
      where: { cycleId: cycle.id },
      select: { stableKey: true },
    });
    const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));
    const baseNumber = await nextAccountingRecordNumber();
    const baseSequence = Number(baseNumber.split('-').pop()) || 1;
    const year = new Date().getFullYear();
    const seen = new Set();
    const createdRows = [];
    let created = 0;
    let skipped = 0;
    let createdNew = 0;
    let createdModified = 0;
    let createdUnchanged = 0;

    for (const item of input.items) {
      if (!itemIsValid(item)) {
        skipped += 1;
        continue;
      }
      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});
      if (seen.has(stableKey) || targetKeys.has(stableKey)) {
        skipped += 1;
        continue;
      }
      seen.add(stableKey);
      const sourceFingerprint = createAccountingFingerprint(item.recordType, item.payload || {});
      const previous = baseByKey.get(stableKey);
      const changeType = !previous ? 'new' : previous.sourceFingerprint === sourceFingerprint ? 'unchanged' : 'modified';
      const data = buildAccountingSnapshotData(item, req.authUser, {
        cycleId: cycle.id,
        stableKey,
        sourceFingerprint,
        changeType,
        previousRecordId: previous?.id || null,
      });

      createdRows.push({
        ...data,
        recordNumber: `ACT-${year}-${String(baseSequence + created).padStart(6, '0')}`,
        createdBy: userLabel(req),
      });
      targetKeys.add(stableKey);
      created += 1;
      if (changeType === 'new') createdNew += 1;
      else if (changeType === 'modified') createdModified += 1;
      else createdUnchanged += 1;
    }

    if (createdRows.length) {
      for (let index = 0; index < createdRows.length; index += 750) {
        await prisma.accountingTransformationRecord.createMany({ data: createdRows.slice(index, index + 750) });
      }
    }

    const updatedCycle = await prisma.accountingTransformationCycle.update({
      where: { id: cycle.id },
      data: {
        sourceFileName: input.fileName || cycle.sourceFileName || null,
        importedAt: new Date(),
        importedBy: userLabel(req),
      },
      include: { _count: { select: { records: true } } },
    });

    await createAuditLog({
      user: req.authUser,
      action: 'cycle_import',
      module: 'accounting_transformation',
      entity: 'accounting_cycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      description: `استيراد بيانات إلى دورة التحديث: ${created} سجل`,
      newData: { created, skipped, new: createdNew, modified: createdModified, unchanged: createdUnchanged, fileName: input.fileName || null },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      created,
      updated: 0,
      skipped,
      total: input.items.length,
      new: createdNew,
      modified: createdModified,
      unchanged: createdUnchanged,
      cycle: serializeCycle(updatedCycle),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/review', async (req, res, next) => {
  try {
    if (!canEditCycles(req)) return res.status(403).json({ message: 'اعتماد مرحلة المراجعة يتطلب صلاحية التعديل' });
    const cycle = await getCycleOr404(req, res);
    if (!cycle || !assertDraftCycle(cycle, res)) return;
    if (!cycle._count.records) return res.status(409).json({ message: 'لا يمكن إرسال دورة فارغة للمراجعة' });

    const updated = await prisma.accountingTransformationCycle.update({
      where: { id: cycle.id },
      data: { status: 'under_review', reviewedAt: new Date(), reviewedBy: userLabel(req) },
      include: { _count: { select: { records: true } } },
    });
    res.json(serializeCycle(updated));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/reopen', async (req, res, next) => {
  try {
    if (!canEditCycles(req)) return res.status(403).json({ message: 'إعادة الدورة للمسودة تتطلب صلاحية التعديل' });
    const cycle = await getCycleOr404(req, res);
    if (!cycle || cycle.isCurrent || cycle.status !== 'under_review') return res.status(409).json({ message: 'يمكن إعادة الدورات تحت المراجعة فقط' });
    const updated = await prisma.accountingTransformationCycle.update({
      where: { id: cycle.id },
      data: { status: 'draft' },
      include: { _count: { select: { records: true } } },
    });
    res.json(serializeCycle(updated));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    if (!canApproveCycles(req)) return res.status(403).json({ message: 'اعتماد دورة التحديث يتطلب صلاحية «اعتماد دورة»' });
    const cycle = await getCycleOr404(req, res);
    if (!cycle) return;
    if (cycle.status !== 'under_review' || cycle.isCurrent) {
      return res.status(409).json({ message: 'يجب إرسال الدورة للمراجعة قبل اعتمادها' });
    }
    if (!cycle._count.records) return res.status(409).json({ message: 'لا يمكن اعتماد دورة لا تحتوي على بيانات' });

    const carriedForward = await carryForwardUnchangedAccountingRecords(cycle);
    const unresolved = await prisma.accountingTransformationRecord.count({
      where: { cycleId: cycle.id, committeeStatus: { in: ['not_reviewed', 'under_review', 'needs_update'] } },
    });
    if (unresolved) {
      return res.status(409).json({ message: `لا يمكن اعتماد الدورة: يوجد ${unresolved} سجل لم تُحسم مراجعته أو يحتاج تحديثًا.` });
    }
    const comparison = await getAccountingCycleComparison(cycle);
    const approvedBy = userLabel(req);
    const approvedAt = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.accountingTransformationCycle.updateMany({
        where: { isCurrent: true, id: { not: cycle.id } },
        data: { isCurrent: false, status: 'archived', archivedAt: approvedAt },
      });
      await tx.accountingTransformationCycle.update({
        where: { id: cycle.id },
        data: { isCurrent: true, status: 'approved', approvedAt, approvedBy },
      });
    });

    const updated = await prisma.accountingTransformationCycle.findUnique({
      where: { id: cycle.id },
      include: { _count: { select: { records: true } } },
    });

    await createAuditLog({
      user: req.authUser,
      action: 'approve_cycle',
      module: 'accounting_transformation',
      entity: 'accounting_cycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      description: 'اعتماد دورة تحديث وجعلها البيانات الحالية',
      newData: { cycle: updated, comparison, carriedForward },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.json({ cycle: serializeCycle(updated), comparison });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const cycle = await getCycleOr404(req, res);
    if (!cycle) return;
    if (cycle.isCurrent || !['draft', 'under_review'].includes(cycle.status)) {
      return res.status(409).json({ message: 'لا يمكن حذف دورة معتمدة أو مؤرشفة؛ تبقى محفوظة كسجل تاريخي' });
    }
    await prisma.accountingTransformationCycle.delete({ where: { id: cycle.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
