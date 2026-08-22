import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import {
  buildAccountingSnapshotData,
  createAccountingFingerprint,
  createAccountingStableKey,
} from '../services/accountingCycles.service.js';
import { hasAccountingValue } from '../config/accountingTransformation.js';

const router = Router();

const CONFIRMATION_PHRASE = 'إعادة تأسيس بيانات اللجنة';

const itemSchema = z.object({
  recordType: z.enum(['land', 'building', 'fixed_asset']),
  ownershipMode: z.enum(['owned', 'leased', 'other']).optional(),
  committeeStatus: z.enum(['not_reviewed', 'under_review', 'needs_update', 'approved', 'completed']).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(z.unknown()).default([]),
  notes: z.string().trim().nullable().optional(),
});

const resetSchema = z.object({
  confirmation: z.string().trim(),
  fileName: z.string().trim().min(1).max(255),
  cycleName: z.string().trim().min(3).max(180).default('البيانات الأساسية المعتمدة'),
  items: z.array(itemSchema).min(1).max(10000),
});

const userLabel = (req) => req.authUser?.email || req.authUser?.username || null;

const itemIsValid = (item) => {
  const payload = item.payload || {};
  if (item.recordType === 'fixed_asset') {
    return ['Y', 'Z', 'AA', 'AB'].some((column) => hasAccountingValue(payload[column]));
  }
  return hasAccountingValue(payload.B) || hasAccountingValue(payload.D) || hasAccountingValue(payload.E) || hasAccountingValue(payload.G);
};

router.post('/reset-baseline', async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'admin') {
      return res.status(403).json({ message: 'إعادة تأسيس بيانات لجنة التحول المحاسبي متاحة لمسؤول النظام فقط.' });
    }

    const input = resetSchema.parse(req.body);
    if (input.confirmation !== CONFIRMATION_PHRASE) {
      return res.status(400).json({ message: `اكتب عبارة التأكيد حرفيًا: ${CONFIRMATION_PHRASE}` });
    }

    const before = await Promise.all([
      prisma.accountingTransformationCycle.count(),
      prisma.accountingTransformationRecord.count(),
    ]);

    const prepared = [];
    const seen = new Set();
    let invalid = 0;
    let duplicate = 0;
    const typeCounts = { land: 0, building: 0, fixed_asset: 0 };
    const importedBy = userLabel(req);
    const now = new Date();
    const year = now.getFullYear();

    for (const item of input.items) {
      if (!itemIsValid(item)) {
        invalid += 1;
        continue;
      }
      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});
      const normalizedKey = String(stableKey || '').trim().toLowerCase();
      if (!normalizedKey || seen.has(normalizedKey)) {
        duplicate += 1;
        continue;
      }
      seen.add(normalizedKey);
      typeCounts[item.recordType] += 1;
      prepared.push({ item, stableKey });
    }

    if (!prepared.length) {
      return res.status(400).json({ message: 'لم يتم العثور على سجلات صالحة يمكن اعتمادها كأساس جديد.' });
    }

    const cycle = await prisma.$transaction(async (tx) => {
      // Delete committee operational data only. Official templates, permissions and audit logs are preserved.
      await tx.accountingTransformationRecord.deleteMany({});
      await tx.accountingTransformationCycle.deleteMany({});

      const createdCycle = await tx.accountingTransformationCycle.create({
        data: {
          cycleNumber: 1,
          name: input.cycleName,
          description: `دورة أساس أُعيد تأسيسها من ملف Excel: ${input.fileName}`,
          status: 'approved',
          isCurrent: true,
          basedOnCycleId: null,
          sourceFileName: input.fileName,
          importedAt: now,
          importedBy,
          reviewedAt: now,
          reviewedBy: importedBy,
          approvedAt: now,
          approvedBy: importedBy,
          createdBy: importedBy,
        },
      });

      const rows = prepared.map(({ item, stableKey }, index) => {
        const payload = item.payload || {};
        const sourceFingerprint = createAccountingFingerprint(item.recordType, payload);
        const snapshot = buildAccountingSnapshotData(
          { ...item, committeeStatus: 'approved', payload },
          req.authUser,
          {
            cycleId: createdCycle.id,
            stableKey,
            sourceFingerprint,
            changeType: 'baseline',
            previousRecordId: null,
          },
        );
        return {
          ...snapshot,
          recordNumber: `ACT-${year}-${String(index + 1).padStart(6, '0')}`,
          committeeStatus: 'approved',
          changeType: 'baseline',
          createdBy: importedBy,
          updatedBy: importedBy,
        };
      });

      for (let index = 0; index < rows.length; index += 500) {
        await tx.accountingTransformationRecord.createMany({ data: rows.slice(index, index + 500) });
      }

      return createdCycle;
    }, { timeout: 120000 });

    await createAuditLog({
      user: req.authUser,
      action: 'reset_accounting_transformation_baseline',
      module: 'accounting_transformation',
      entity: 'accounting_cycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      description: `إعادة تأسيس بيانات لجنة التحول المحاسبي من ${input.fileName} واعتماد ${prepared.length} سجلًا كأساس جديد`,
      previousData: { cycles: before[0], records: before[1] },
      newData: {
        cycleNumber: 1,
        cycleId: cycle.id,
        fileName: input.fileName,
        imported: prepared.length,
        invalid,
        duplicate,
        typeCounts,
      },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json({
      message: 'تم حذف بيانات الدورات السابقة وإعادة تأسيس اللجنة من ملف Excel بنجاح.',
      cycle,
      deleted: { cycles: before[0], records: before[1] },
      imported: prepared.length,
      invalid,
      duplicate,
      typeCounts,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
