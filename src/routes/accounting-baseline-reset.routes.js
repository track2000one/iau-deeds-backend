import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { getClientIp } from '../services/audit.service.js';
import {
  buildAccountingSnapshotData,
  createAccountingFingerprint,
  createAccountingStableKey,
} from '../services/accountingCycles.service.js';
import { getCurrentAccountingTemplateWithVersion } from '../services/accountingTemplateVersions.service.js';
import { hasAccountingValue } from '../config/accountingTransformation.js';

const router = Router();

const CONFIRMATION_PHRASE = 'إعادة تأسيس بيانات اللجنة';
const CURRENT_YEAR = new Date().getFullYear();
const DEFAULT_BASELINE_NAME = `البيانات الأساسية المعتمدة ${CURRENT_YEAR}`;

const itemSchema = z.object({
  recordType: z.enum(['land', 'building', 'fixed_asset']),
  ownershipMode: z.enum(['owned', 'leased', 'other']).optional(),
  committeeStatus: z.enum(['not_reviewed', 'under_review', 'needs_update', 'approved', 'completed']).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(z.unknown()).default([]),
  notes: z.string().trim().nullable().optional(),
});

const previewSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  items: z.array(itemSchema).min(1).max(10000),
});

const resetSchema = previewSchema.extend({
  confirmation: z.string().trim(),
  cycleName: z.string().trim().min(3).max(180).default(DEFAULT_BASELINE_NAME),
  expectedImpact: z.object({
    cycles: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
    cycleTemplateSnapshots: z.number().int().nonnegative(),
  }),
  expectedDatasetFingerprint: z.string().trim().min(32).max(128),
});

const userLabel = (req) => req.authUser?.email || req.authUser?.username || null;

const itemIsValid = (item) => {
  const payload = item.payload || {};
  if (item.recordType === 'fixed_asset') {
    return ['Y', 'Z', 'AA', 'AB'].some((column) => hasAccountingValue(payload[column]));
  }
  return hasAccountingValue(payload.B) || hasAccountingValue(payload.D) || hasAccountingValue(payload.E) || hasAccountingValue(payload.G);
};

const prepareItems = (items) => {
  const prepared = [];
  const seen = new Set();
  let invalid = 0;
  let duplicate = 0;
  const typeCounts = { land: 0, building: 0, fixed_asset: 0 };

  for (const item of items) {
    if (!itemIsValid(item)) {
      invalid += 1;
      continue;
    }
    const payload = item.payload || {};
    const stableKey = createAccountingStableKey(item.recordType, payload);
    const normalizedKey = String(stableKey || '').trim().toLowerCase();
    if (!normalizedKey || seen.has(normalizedKey)) {
      duplicate += 1;
      continue;
    }
    seen.add(normalizedKey);
    const sourceFingerprint = createAccountingFingerprint(item.recordType, payload);
    typeCounts[item.recordType] += 1;
    prepared.push({ item, stableKey, sourceFingerprint });
  }

  const datasetFingerprint = crypto
    .createHash('sha256')
    .update(prepared.map((entry) => `${entry.stableKey}:${entry.sourceFingerprint}`).sort().join('|'))
    .digest('hex');

  return { prepared, invalid, duplicate, typeCounts, datasetFingerprint };
};

const getImpact = async (client = prisma) => {
  const [cycles, records, cycleTemplateSnapshots, users, permissions, auditLogs, officialTemplateVersions, statusGroups, currentCycle] = await Promise.all([
    client.accountingTransformationCycle.count(),
    client.accountingTransformationRecord.count(),
    client.accountingCycleTemplateSnapshot.count(),
    client.appUser.count(),
    client.userPermission.count(),
    client.auditLog.count(),
    client.assetExcelTemplate.count({
      where: {
        OR: [
          { templateKey: 'official_accounting_transformation' },
          { templateKey: { startsWith: 'official_accounting_transformation:v' } },
        ],
      },
    }),
    client.accountingTransformationCycle.groupBy({ by: ['status'], _count: { _all: true } }),
    client.accountingTransformationCycle.findFirst({
      where: { isCurrent: true },
      select: { id: true, cycleNumber: true, name: true, status: true },
      orderBy: [{ approvedAt: 'desc' }, { updatedAt: 'desc' }],
    }),
  ]);

  const statuses = statusGroups.reduce((acc, item) => {
    acc[item.status] = item._count._all;
    return acc;
  }, {});

  return {
    destructive: { cycles, records, cycleTemplateSnapshots },
    preserved: { users, permissions, auditLogs, officialTemplateVersions },
    statuses,
    currentCycle: currentCycle ? {
      id: currentCycle.id,
      cycleNumber: currentCycle.cycleNumber,
      name: currentCycle.name,
      status: currentCycle.status,
    } : null,
  };
};

const impactMatches = (expected, actual) =>
  Number(expected.cycles) === Number(actual.cycles)
  && Number(expected.records) === Number(actual.records)
  && Number(expected.cycleTemplateSnapshots) === Number(actual.cycleTemplateSnapshots);

router.post('/reset-baseline/preview', async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'admin') {
      return res.status(403).json({ message: 'معاينة إعادة تأسيس بيانات اللجنة متاحة لمسؤول النظام فقط.' });
    }

    const input = previewSchema.parse(req.body);
    const preparedResult = prepareItems(input.items);
    if (!preparedResult.prepared.length) {
      return res.status(400).json({ message: 'لم يتم العثور على سجلات صالحة يمكن اعتمادها كأساس جديد.' });
    }

    const impact = await getImpact();
    const currentTemplate = await getCurrentAccountingTemplateWithVersion().catch(() => null);

    return res.json({
      fileName: input.fileName,
      sourceRows: input.items.length,
      willImport: preparedResult.prepared.length,
      invalid: preparedResult.invalid,
      duplicate: preparedResult.duplicate,
      typeCounts: preparedResult.typeCounts,
      datasetFingerprint: preparedResult.datasetFingerprint,
      suggestedCycleName: DEFAULT_BASELINE_NAME,
      impact,
      officialTemplate: currentTemplate ? {
        id: currentTemplate.id,
        fileName: currentTemplate.fileName,
        versionNumber: Number(currentTemplate.versionNumber || 1),
      } : null,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-baseline', async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'admin') {
      return res.status(403).json({ message: 'إعادة تأسيس بيانات لجنة التحول المحاسبي متاحة لمسؤول النظام فقط.' });
    }

    const input = resetSchema.parse(req.body);
    if (input.confirmation !== CONFIRMATION_PHRASE) {
      return res.status(400).json({ message: `اكتب عبارة التأكيد حرفيًا: ${CONFIRMATION_PHRASE}` });
    }

    const preparedResult = prepareItems(input.items);
    if (!preparedResult.prepared.length) {
      return res.status(400).json({ message: 'لم يتم العثور على سجلات صالحة يمكن اعتمادها كأساس جديد.' });
    }
    if (preparedResult.datasetFingerprint !== input.expectedDatasetFingerprint) {
      return res.status(409).json({ message: 'تغيرت بيانات ملف الأساس بعد المعاينة. أعد تحليل الملف ومعاينته قبل التنفيذ.' });
    }

    const importedBy = userLabel(req);
    const now = new Date();
    const year = now.getFullYear();
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const currentTemplate = await getCurrentAccountingTemplateWithVersion().catch(() => null);

    const transactionResult = await prisma.$transaction(async (tx) => {
      const liveImpact = await getImpact(tx);
      if (!impactMatches(input.expectedImpact, liveImpact.destructive)) {
        const staleError = new Error('STALE_BASELINE_IMPACT');
        staleError.code = 'STALE_BASELINE_IMPACT';
        staleError.liveImpact = liveImpact;
        throw staleError;
      }

      await tx.accountingCycleTemplateSnapshot.deleteMany({});
      await tx.accountingTransformationRecord.deleteMany({});
      await tx.accountingTransformationCycle.deleteMany({});

      const createdCycle = await tx.accountingTransformationCycle.create({
        data: {
          cycleNumber: 1,
          name: input.cycleName || DEFAULT_BASELINE_NAME,
          description: `دورة أساس رسمية أُعيد تأسيسها من ملف Excel: ${input.fileName}`,
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

      const rows = preparedResult.prepared.map(({ item, stableKey, sourceFingerprint }, index) => {
        const payload = item.payload || {};
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

      let templateSnapshot = null;
      if (currentTemplate) {
        templateSnapshot = await tx.accountingCycleTemplateSnapshot.create({
          data: {
            cycleId: createdCycle.id,
            templateId: currentTemplate.id,
            fileName: currentTemplate.fileName,
            versionNumber: Number(currentTemplate.versionNumber || 1),
            driveFileId: currentTemplate.driveFileId,
            attachedAt: now,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: 'reset_accounting_transformation_baseline',
          module: 'accounting_transformation',
          entity: 'accounting_cycle',
          entityId: createdCycle.id,
          entityLabel: createdCycle.name,
          status: 'success',
          description: `إعادة تأسيس بيانات لجنة التحول المحاسبي من ${input.fileName} واعتماد ${preparedResult.prepared.length} سجلًا كأساس رسمي جديد`,
          previousData: liveImpact,
          newData: {
            cycleNumber: 1,
            cycleId: createdCycle.id,
            fileName: input.fileName,
            imported: preparedResult.prepared.length,
            invalid: preparedResult.invalid,
            duplicate: preparedResult.duplicate,
            typeCounts: preparedResult.typeCounts,
            officialTemplateVersion: templateSnapshot?.versionNumber || null,
          },
          ipAddress,
          userAgent,
        },
      });

      return { cycle: createdCycle, deletedImpact: liveImpact, templateSnapshot };
    }, { timeout: 120000, isolationLevel: 'Serializable' });

    return res.status(201).json({
      message: 'تم حذف بيانات الدورات السابقة وإعادة تأسيس اللجنة من ملف Excel بنجاح.',
      cycle: transactionResult.cycle,
      deleted: transactionResult.deletedImpact.destructive,
      imported: preparedResult.prepared.length,
      invalid: preparedResult.invalid,
      duplicate: preparedResult.duplicate,
      typeCounts: preparedResult.typeCounts,
      officialTemplate: transactionResult.templateSnapshot,
    });
  } catch (error) {
    if (error?.code === 'STALE_BASELINE_IMPACT' || error?.message === 'STALE_BASELINE_IMPACT') {
      return res.status(409).json({
        message: 'تغيرت بيانات اللجنة منذ آخر معاينة. لم يتم حذف أي شيء. حدّث المعاينة ثم حاول مرة أخرى.',
        impact: error.liveImpact || null,
      });
    }
    next(error);
  }
});

export default router;
