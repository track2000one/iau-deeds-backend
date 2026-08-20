import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import {
  buildAccountingSnapshotData,
  canonicalizeAccountingStableKey,
  createAccountingFingerprint,
  createAccountingStableKey,
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
  recordType: z.enum(['land', 'building', 'fixed_asset']),
  ownershipMode: z.enum(['owned', 'leased', 'other']).optional(),
  committeeStatus: z.enum(['not_reviewed', 'under_review', 'needs_update', 'approved', 'completed']).default('not_reviewed'),
  payload: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(attachmentSchema).default([]),
  notes: z.string().trim().nullable().optional(),
});

const importSchema = z.object({
  items: z.array(recordInputSchema).min(1).max(10000),
  fileName: z.string().trim().max(255).nullable().optional(),
});

const userLabel = (req) => req.authUser?.email || req.authUser?.username || null;
const canonicalKey = (value) => canonicalizeAccountingStableKey(value);

const itemIsValid = (item) => {
  const payload = item.payload || {};
  if (item.recordType === 'fixed_asset') {
    return ['Y', 'Z', 'AA', 'AB'].some((column) => hasAccountingValue(payload[column]));
  }
  return hasAccountingValue(payload.B) || hasAccountingValue(payload.D) || hasAccountingValue(payload.E) || hasAccountingValue(payload.G);
};

const mergeAccountingPayload = (previous = {}, incoming = {}) => {
  const merged = { ...(previous || {}) };
  const clearFields = Array.isArray(incoming?.__clearFields) ? incoming.__clearFields.map(String) : [];
  for (const [key, value] of Object.entries(incoming || {})) {
    if (key === '__clearFields') continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    merged[key] = value;
  }
  for (const field of clearFields) merged[field] = '';
  return merged;
};

const getDraftCycle = async (req, res) => {
  const cycle = await prisma.accountingTransformationCycle.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { records: true } } },
  });
  if (!cycle) {
    res.status(404).json({ message: 'دورة التحديث غير موجودة' });
    return null;
  }
  if (cycle.status !== 'draft' || cycle.isCurrent) {
    res.status(409).json({
      message: cycle.status === 'under_review'
        ? 'الدورة تحت المراجعة ومجمّدة. أعدها إلى المسودة قبل تعديل بياناتها.'
        : 'لا يمكن تعديل هذه الدورة بعد اعتمادها أو أرشفتها',
    });
    return null;
  }
  return cycle;
};

const classifyAgainstBase = (item, previous, mergedPayload) => {
  const fingerprint = createAccountingFingerprint(item.recordType, mergedPayload);
  const changeType = !previous
    ? 'new'
    : previous.recordType === item.recordType && previous.sourceFingerprint === fingerprint
      ? 'unchanged'
      : 'modified';
  return { fingerprint, changeType };
};

const loadCycleMaps = async (cycle) => {
  const [baseRecords, targetRecords] = await Promise.all([
    cycle.basedOnCycleId
      ? prisma.accountingTransformationRecord.findMany({
          where: { cycleId: cycle.basedOnCycleId },
          select: { id: true, stableKey: true, sourceFingerprint: true, payload: true, recordType: true },
        })
      : Promise.resolve([]),
    prisma.accountingTransformationRecord.findMany({
      where: { cycleId: cycle.id },
      select: { id: true, recordNumber: true, stableKey: true, sourceFingerprint: true, payload: true, recordType: true },
    }),
  ]);

  const baseByKey = new Map();
  for (const record of baseRecords) {
    const key = canonicalKey(record.stableKey);
    if (key && !baseByKey.has(key)) baseByKey.set(key, record);
  }
  const targetByKey = new Map();
  for (const record of targetRecords) {
    const key = canonicalKey(record.stableKey);
    if (key && !targetByKey.has(key)) targetByKey.set(key, record);
  }
  return { baseRecords, baseByKey, targetByKey };
};

router.post('/:id/import-preview', async (req, res, next) => {
  try {
    const input = importSchema.parse(req.body);
    const cycle = await getDraftCycle(req, res);
    if (!cycle) return;

    const { baseRecords, baseByKey, targetByKey } = await loadCycleMaps(cycle);
    const seen = new Set();
    const fileKeys = new Set();
    const invalidIndexes = [];
    const duplicateIndexes = [];
    const freshIndexes = [];
    const newIndexes = [];
    const modifiedIndexes = [];
    const unchangedIndexes = [];
    const cycleUpdateIndexes = [];
    const alreadyImportedIndexes = [];

    input.items.forEach((item, index) => {
      if (!itemIsValid(item)) {
        invalidIndexes.push(index);
        return;
      }

      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});
      const matchKey = canonicalKey(stableKey);
      if (!matchKey || seen.has(matchKey)) {
        duplicateIndexes.push(index);
        return;
      }
      seen.add(matchKey);
      fileKeys.add(matchKey);

      const previous = baseByKey.get(matchKey);
      const canMerge = previous && previous.recordType === item.recordType;
      const mergedPayload = canMerge ? mergeAccountingPayload(previous.payload || {}, item.payload || {}) : (item.payload || {});
      const { fingerprint, changeType } = classifyAgainstBase(item, previous, mergedPayload);

      if (changeType === 'new') newIndexes.push(index);
      else if (changeType === 'modified') modifiedIndexes.push(index);
      else unchangedIndexes.push(index);

      const target = targetByKey.get(matchKey);
      if (!target) {
        freshIndexes.push(index);
        return;
      }

      if (target.recordType === item.recordType && target.sourceFingerprint === fingerprint) {
        duplicateIndexes.push(index);
        alreadyImportedIndexes.push(index);
        return;
      }

      // The same asset already exists in the open draft, but the incoming file
      // contains a newer version. Treat it as an actionable draft update instead
      // of a duplicate so that repeated departmental files can reconcile safely.
      cycleUpdateIndexes.push(index);
      freshIndexes.push(index);
    });

    const notSupplied = baseRecords.filter((item) => {
      const key = canonicalKey(item.stableKey);
      return key && !fileKeys.has(key);
    }).length;

    res.json({
      total: input.items.length,
      fresh: freshIndexes.length,
      duplicate: duplicateIndexes.length,
      invalid: invalidIndexes.length,
      cycleUpdate: cycleUpdateIndexes.length,
      alreadyImported: alreadyImportedIndexes.length,
      freshIndexes,
      duplicateIndexes,
      invalidIndexes,
      cycleUpdateIndexes,
      alreadyImportedIndexes,
      new: newIndexes.length,
      modified: modifiedIndexes.length,
      unchanged: unchangedIndexes.length,
      removed: 0,
      notSupplied,
      newIndexes,
      modifiedIndexes,
      unchangedIndexes,
    });
  } catch (error) { next(error); }
});

router.post('/:id/import', async (req, res, next) => {
  try {
    const input = importSchema.parse(req.body);
    const cycle = await getDraftCycle(req, res);
    if (!cycle) return;

    const { baseByKey, targetByKey } = await loadCycleMaps(cycle);
    const baseNumber = await nextAccountingRecordNumber();
    const baseSequence = Number(baseNumber.split('-').pop()) || 1;
    const year = new Date().getFullYear();
    const seen = new Set();
    const createdRows = [];
    const updateOperations = [];
    let skipped = 0;
    let updated = 0;
    let createdNew = 0;
    let createdModified = 0;
    let createdUnchanged = 0;

    for (const item of input.items) {
      if (!itemIsValid(item)) { skipped += 1; continue; }
      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});
      const matchKey = canonicalKey(stableKey);
      if (!matchKey || seen.has(matchKey)) { skipped += 1; continue; }
      seen.add(matchKey);

      const previous = baseByKey.get(matchKey);
      const canMerge = previous && previous.recordType === item.recordType;
      const mergedPayload = canMerge ? mergeAccountingPayload(previous.payload || {}, item.payload || {}) : (item.payload || {});
      const { fingerprint: sourceFingerprint, changeType } = classifyAgainstBase(item, previous, mergedPayload);
      const target = targetByKey.get(matchKey);

      if (target && target.recordType === item.recordType && target.sourceFingerprint === sourceFingerprint) {
        skipped += 1;
        continue;
      }

      const data = buildAccountingSnapshotData({ ...item, payload: mergedPayload }, req.authUser, {
        cycleId: cycle.id,
        stableKey,
        sourceFingerprint,
        changeType,
        previousRecordId: previous?.id || null,
      });

      if (target) {
        updateOperations.push(prisma.accountingTransformationRecord.update({
          where: { id: target.id },
          data,
        }));
        updated += 1;
      } else {
        const sequence = baseSequence + createdRows.length;
        createdRows.push({
          ...data,
          recordNumber: `ACT-${year}-${String(sequence).padStart(6, '0')}`,
          createdBy: userLabel(req),
        });
      }

      if (changeType === 'new') createdNew += 1;
      else if (changeType === 'modified') createdModified += 1;
      else createdUnchanged += 1;
    }

    if (createdRows.length) {
      for (let index = 0; index < createdRows.length; index += 750) {
        await prisma.accountingTransformationRecord.createMany({ data: createdRows.slice(index, index + 750) });
      }
    }
    for (let index = 0; index < updateOperations.length; index += 200) {
      await prisma.$transaction(updateOperations.slice(index, index + 200));
    }

    const updatedCycle = await prisma.accountingTransformationCycle.update({
      where: { id: cycle.id },
      data: { sourceFileName: input.fileName || cycle.sourceFileName || null, importedAt: new Date(), importedBy: userLabel(req) },
      include: { _count: { select: { records: true } } },
    });

    await createAuditLog({
      user: req.authUser,
      action: 'cycle_import',
      module: 'accounting_transformation',
      entity: 'accounting_cycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      description: `مصالحة ملف داخل دورة التحديث: ${createdRows.length} إضافة و${updated} تحديث`,
      newData: {
        created: createdRows.length,
        updated,
        skipped,
        new: createdNew,
        modified: createdModified,
        unchanged: createdUnchanged,
        fileName: input.fileName || null,
      },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      created: createdRows.length,
      updated,
      skipped,
      total: input.items.length,
      new: createdNew,
      modified: createdModified,
      unchanged: createdUnchanged,
      cycle: {
        ...updatedCycle,
        recordCount: updatedCycle._count?.records ?? 0,
        _count: undefined,
      },
    });
  } catch (error) { next(error); }
});

export default router;
