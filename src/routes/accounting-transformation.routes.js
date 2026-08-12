import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import {
  ACCOUNTING_CORE_COLUMNS,
  calculateAccountingProgress,
  hasAccountingValue,
  inferAccountingOwnershipMode,
} from '../config/accountingTransformation.js';

const router = Router();

const recordTypeSchema = z.enum(['land', 'building']);
const committeeStatusSchema = z.enum([
  'not_reviewed',
  'under_review',
  'needs_update',
  'approved',
  'completed',
]);
const ownershipModeSchema = z.enum(['owned', 'leased', 'other']);
const attachmentSchema = z.object({
  title: z.string().trim().min(1),
  driveUrl: z.string().trim().min(1),
  driveFileId: z.string().trim().nullable().optional(),
  mimeType: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
});

const recordInputSchema = z.object({
  recordType: recordTypeSchema,
  ownershipMode: ownershipModeSchema.optional(),
  committeeStatus: committeeStatusSchema.default('not_reviewed'),
  payload: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(attachmentSchema).default([]),
  notes: z.string().trim().nullable().optional(),
});

const bulkImportSchema = z.object({
  items: z.array(recordInputSchema).min(1).max(1500),
});

const normalizedText = (value) => String(value ?? '').trim();

const coreFromPayload = (recordType, payload = {}) => {
  const map = ACCOUNTING_CORE_COLUMNS[recordType] || ACCOUNTING_CORE_COLUMNS.land;
  return {
    entityName: normalizedText(payload.B) || null,
    entityCode: normalizedText(payload.C) || null,
    mofAssetNumber: normalizedText(payload.D) || null,
    entityAssetNumber: normalizedText(payload.E) || null,
    linkedAsset: normalizedText(payload.F) || null,
    assetDescription: normalizedText(payload.G) || null,
    accountingGroup: normalizedText(payload.Q) || null,
    accountingGroupCode: normalizedText(payload.S) || null,
    accountingAssetCode: normalizedText(payload.T) || null,
    region: normalizedText(payload[map.region]) || null,
    city: normalizedText(payload[map.city]) || null,
  };
};

const buildRecordData = (input, authUser, extra = {}) => {
  const payload = input.payload || {};
  const ownershipMode = input.ownershipMode || inferAccountingOwnershipMode(input.recordType, payload);
  const progress = calculateAccountingProgress(input.recordType, payload, ownershipMode);
  return {
    recordType: input.recordType,
    ownershipMode,
    committeeStatus: input.committeeStatus || 'not_reviewed',
    ...coreFromPayload(input.recordType, payload),
    ...progress,
    payload,
    attachments: input.attachments || [],
    notes: input.notes || null,
    updatedBy: authUser?.email || authUser?.username || null,
    ...extra,
  };
};

const createFingerprint = (recordType, payload = {}) =>
  crypto
    .createHash('sha256')
    .update(`${recordType}:${JSON.stringify(payload)}`)
    .digest('hex');

const nextRecordNumber = async (offset = 0) => {
  const year = new Date().getFullYear();
  const start = new Date(`${year}-01-01T00:00:00.000Z`);
  const end = new Date(`${year + 1}-01-01T00:00:00.000Z`);
  const count = await prisma.accountingTransformationRecord.count({
    where: { createdAt: { gte: start, lt: end } },
  });
  return `ACT-${year}-${String(count + offset + 1).padStart(6, '0')}`;
};

const accountingGroupKey = (item) => {
  const code = normalizedText(item.accountingGroupCode);
  const label = normalizedText(item.accountingGroup);
  if (code || label) return { key: `group:${code || label}`, label: label || code, code: code || null };
  return item.recordType === 'land'
    ? { key: 'type:land', label: 'الأراضي', code: null }
    : { key: 'type:building', label: 'المباني', code: null };
};

const queryWhere = (req) => {
  const search = normalizedText(req.query.search);
  const recordType = normalizedText(req.query.recordType);
  const committeeStatus = normalizedText(req.query.committeeStatus);
  const readinessStatus = normalizedText(req.query.readinessStatus);
  const groupKey = normalizedText(req.query.group);

  const groupWhere = groupKey && groupKey !== 'all'
    ? groupKey === 'type:land'
      ? { recordType: 'land' }
      : groupKey === 'type:building'
        ? { recordType: 'building' }
        : groupKey.startsWith('group:')
          ? { OR: [
              { accountingGroupCode: { equals: groupKey.slice(6), mode: 'insensitive' } },
              { accountingGroup: { equals: groupKey.slice(6), mode: 'insensitive' } },
            ] }
          : {}
    : {};

  const baseFilters = {
    ...(recordType && recordType !== 'all' ? { recordType } : {}),
    ...(committeeStatus && committeeStatus !== 'all' ? { committeeStatus } : {}),
    ...(readinessStatus && readinessStatus !== 'all' ? { readinessStatus } : {}),
  };

  const searchWhere = search
    ? { OR: [
        { recordNumber: { contains: search, mode: 'insensitive' } },
        { entityName: { contains: search, mode: 'insensitive' } },
        { entityAssetNumber: { contains: search, mode: 'insensitive' } },
        { mofAssetNumber: { contains: search, mode: 'insensitive' } },
        { linkedAsset: { contains: search, mode: 'insensitive' } },
        { assetDescription: { contains: search, mode: 'insensitive' } },
        { accountingAssetCode: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { region: { contains: search, mode: 'insensitive' } },
      ] }
    : {};

  const clauses = [groupWhere, searchWhere].filter((part) => Object.keys(part).length);
  return {
    ...baseFilters,
    ...(clauses.length > 1 ? { AND: clauses } : clauses[0] || {}),
  };
};

router.get('/groups', async (req, res, next) => {
  try {
    const where = queryWhere(req);
    const records = await prisma.accountingTransformationRecord.findMany({
      where,
      select: {
        recordType: true,
        accountingGroup: true,
        accountingGroupCode: true,
        overallProgress: true,
        censusProgress: true,
        inventoryProgress: true,
        valuationProgress: true,
      },
    });
    const map = new Map();
    for (const item of records) {
      const group = accountingGroupKey(item);
      const current = map.get(group.key) || {
        key: group.key, label: group.label, code: group.code, count: 0,
        overallTotal: 0, censusTotal: 0, inventoryTotal: 0, valuationTotal: 0,
      };
      current.count += 1;
      current.overallTotal += Number(item.overallProgress || 0);
      current.censusTotal += Number(item.censusProgress || 0);
      current.inventoryTotal += Number(item.inventoryProgress || 0);
      current.valuationTotal += Number(item.valuationProgress || 0);
      map.set(group.key, current);
    }
    const groups = Array.from(map.values()).map((g) => ({
      key: g.key, label: g.label, code: g.code, count: g.count,
      averageOverall: Math.round(g.overallTotal / Math.max(1, g.count)),
      averageCensus: Math.round(g.censusTotal / Math.max(1, g.count)),
      averageInventory: Math.round(g.inventoryTotal / Math.max(1, g.count)),
      averageValuation: Math.round(g.valuationTotal / Math.max(1, g.count)),
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ar'));
    res.json(groups);
  } catch (error) { next(error); }
});

router.get('/stats', async (_req, res, next) => {
  try {
    const [
      total,
      lands,
      buildings,
      censusReady,
      inventoryReady,
      valuationReady,
      needsCompletion,
      underReview,
      averages,
    ] = await Promise.all([
      prisma.accountingTransformationRecord.count(),
      prisma.accountingTransformationRecord.count({ where: { recordType: 'land' } }),
      prisma.accountingTransformationRecord.count({ where: { recordType: 'building' } }),
      prisma.accountingTransformationRecord.count({ where: { censusProgress: 100 } }),
      prisma.accountingTransformationRecord.count({ where: { inventoryProgress: 100 } }),
      prisma.accountingTransformationRecord.count({ where: { valuationProgress: 100 } }),
      prisma.accountingTransformationRecord.count({ where: { overallProgress: { lt: 100 } } }),
      prisma.accountingTransformationRecord.count({ where: { committeeStatus: 'under_review' } }),
      prisma.accountingTransformationRecord.aggregate({
        _avg: {
          censusProgress: true,
          inventoryProgress: true,
          valuationProgress: true,
          overallProgress: true,
        },
      }),
    ]);

    res.json({
      total,
      lands,
      buildings,
      censusReady,
      inventoryReady,
      valuationReady,
      needsCompletion,
      underReview,
      averageCensus: Math.round(Number(averages._avg.censusProgress || 0)),
      averageInventory: Math.round(Number(averages._avg.inventoryProgress || 0)),
      averageValuation: Math.round(Number(averages._avg.valuationProgress || 0)),
      averageOverall: Math.round(Number(averages._avg.overallProgress || 0)),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const all = String(req.query.all || '') === '1';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = all ? 10000 : Math.min(200, Math.max(12, Number(req.query.limit) || 36));
    const where = queryWhere(req);

    const [total, items] = await Promise.all([
      prisma.accountingTransformationRecord.count({ where }),
      prisma.accountingTransformationRecord.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        ...(all ? {} : { skip: (page - 1) * limit, take: limit }),
      }),
    ]);

    res.json({
      items,
      page: all ? 1 : page,
      limit,
      total,
      totalPages: all ? 1 : Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/bulk-import', async (req, res, next) => {
  try {
    const input = bulkImportSchema.parse(req.body);
    const baseNumber = await nextRecordNumber(0);
    const baseSequence = Number(baseNumber.split('-').pop()) || 1;
    const year = new Date().getFullYear();
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (let index = 0; index < input.items.length; index += 1) {
      const item = input.items[index];
      const payload = item.payload || {};
      if (!hasAccountingValue(payload.B) && !hasAccountingValue(payload.E) && !hasAccountingValue(payload.G)) {
        skipped += 1;
        continue;
      }

      const sourceFingerprint = createFingerprint(item.recordType, payload);
      const existing = await prisma.accountingTransformationRecord.findUnique({
        where: { sourceFingerprint },
      });
      const data = buildRecordData(item, req.authUser, { sourceFingerprint });

      if (existing) {
        await prisma.accountingTransformationRecord.update({
          where: { id: existing.id },
          data,
        });
        updated += 1;
      } else {
        await prisma.accountingTransformationRecord.create({
          data: {
            ...data,
            recordNumber: `ACT-${year}-${String(baseSequence + created).padStart(6, '0')}`,
            createdBy: req.authUser?.email || req.authUser?.username || null,
          },
        });
        created += 1;
      }
    }

    res.status(201).json({ created, updated, skipped, total: input.items.length });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.accountingTransformationRecord.findUnique({
      where: { id: req.params.id },
    });
    if (!record) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = recordInputSchema.parse(req.body);
    let record = null;

    for (let attempt = 0; attempt < 5 && !record; attempt += 1) {
      const recordNumber = await nextRecordNumber(attempt);
      try {
        record = await prisma.accountingTransformationRecord.create({
          data: {
            ...buildRecordData(input, req.authUser),
            recordNumber,
            createdBy: req.authUser?.email || req.authUser?.username || null,
          },
        });
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
      }
    }

    if (!record) return res.status(409).json({ message: 'تعذر إنشاء رقم سجل فريد، حاول مرة أخرى' });
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const input = recordInputSchema.parse(req.body);
    const current = await prisma.accountingTransformationRecord.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!current) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });

    const record = await prisma.accountingTransformationRecord.update({
      where: { id: req.params.id },
      data: buildRecordData(input, req.authUser),
    });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.accountingTransformationRecord.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    if (error?.code === 'P2025') return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    next(error);
  }
});

export default router;
