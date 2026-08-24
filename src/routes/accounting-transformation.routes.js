import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import { uploadBufferToGoogleDrive, deleteGoogleDriveFile, downloadGoogleDriveFile } from '../services/googleDrive.js';
import { hasAccountingValue } from '../config/accountingTransformation.js';
import {
  buildAccountingSnapshotData,
  createAccountingFingerprint,
  createAccountingStableKey,
  ensureAccountingTransformationBaseline,
  nextAccountingRecordNumber,
} from '../services/accountingCycles.service.js';

const router = Router();

const OFFICIAL_ACCOUNTING_TEMPLATE_KEY = 'official_accounting_transformation';
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const officialAccountingExcelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    const allowed = file.mimetype === EXCEL_MIME || fileName.endsWith('.xlsx');
    cb(allowed ? null : new Error('النموذج الرسمي يجب أن يكون ملف Excel بصيغة XLSX.'), allowed);
  },
});

const recordTypeSchema = z.enum(['land', 'building', 'fixed_asset']);
const committeeStatusSchema = z.enum(['not_reviewed', 'under_review', 'needs_update', 'approved', 'completed']);
const ownershipModeSchema = z.enum(['owned', 'leased', 'other']);
const attachmentSchema = z.object({
  title: z.string().trim().min(1),
  driveUrl: z.string().trim().min(1),
  driveFileId: z.string().trim().nullable().optional(),
  mimeType: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  documentPurpose: z.enum(['ownership_acquisition', 'maintenance', 'valuation', 'asset_image', 'other']).nullable().optional(),
  documentType: z.string().trim().nullable().optional(),
  documentNumber: z.string().trim().nullable().optional(),
  archiveNumber: z.string().trim().nullable().optional(),
});

const recordInputSchema = z.object({
  recordType: recordTypeSchema,
  ownershipMode: ownershipModeSchema.optional(),
  committeeStatus: committeeStatusSchema.default('not_reviewed'),
  payload: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(attachmentSchema).default([]),
  notes: z.string().trim().nullable().optional(),
});

const bulkImportSchema = z.object({ items: z.array(recordInputSchema).min(1).max(10000) });
const normalizedText = (value) => String(value ?? '').trim();
const itemIsValid = (item) => {
  const payload = item.payload || {};
  if (item.recordType === 'fixed_asset') return ['Y','Z','AA','AB'].some((column) => hasAccountingValue(payload[column]));
  return hasAccountingValue(payload.B) || hasAccountingValue(payload.D) || hasAccountingValue(payload.E) || hasAccountingValue(payload.G);
};

const accountingGroupKey = (item) => {
  const code = normalizedText(item.accountingGroupCode);
  const label = normalizedText(item.accountingGroup);
  if (code || label) return { key: `group:${code || label}`, label: label || code, code: code || null };
  if (item.recordType === 'fixed_asset') return { key: 'type:fixed_asset', label: 'سجل الأصول الثابتة', code: null };
  if (item.recordType === 'land') return { key: 'type:land', label: 'الأراضي — مصدر قديم', code: null };
  return { key: 'type:building', label: 'المباني — مصدر قديم', code: null };
};

const queryWhere = (req) => {
  const search = normalizedText(req.query.search);
  const recordType = normalizedText(req.query.recordType);
  const committeeStatus = normalizedText(req.query.committeeStatus);
  const readinessStatus = normalizedText(req.query.readinessStatus);
  const groupKey = normalizedText(req.query.group);
  const cycleId = normalizedText(req.query.cycleId);
  const includeHistory = String(req.query.includeHistory || '') === '1';
  const cycleWhere = includeHistory ? {} : cycleId ? { cycleId } : { cycle: { isCurrent: true } };

  const groupWhere = groupKey && groupKey !== 'all'
    ? groupKey === 'type:land' ? { recordType: 'land' }
      : groupKey === 'type:building' ? { recordType: 'building' }
        : groupKey === 'type:fixed_asset' ? { recordType: 'fixed_asset' }
          : groupKey.startsWith('group:')
            ? { OR: [
                { accountingGroupCode: { equals: groupKey.slice(6), mode: 'insensitive' } },
                { accountingGroup: { equals: groupKey.slice(6), mode: 'insensitive' } },
              ] }
            : {}
    : {};

  const baseFilters = {
    ...cycleWhere,
    ...(recordType && recordType !== 'all' ? { recordType } : {}),
    ...(committeeStatus && committeeStatus !== 'all' ? { committeeStatus } : {}),
    ...(readinessStatus && readinessStatus !== 'all' ? { readinessStatus } : {}),
  };
  const searchWhere = search ? { OR: [
    { recordNumber: { contains: search, mode: 'insensitive' } },
    { entityName: { contains: search, mode: 'insensitive' } },
    { entityAssetNumber: { contains: search, mode: 'insensitive' } },
    { mofAssetNumber: { contains: search, mode: 'insensitive' } },
    { linkedAsset: { contains: search, mode: 'insensitive' } },
    { assetDescription: { contains: search, mode: 'insensitive' } },
    { accountingAssetCode: { contains: search, mode: 'insensitive' } },
    { city: { contains: search, mode: 'insensitive' } },
    { region: { contains: search, mode: 'insensitive' } },
  ] } : {};
  const clauses = [groupWhere, searchWhere].filter((part) => Object.keys(part).length);
  return { ...baseFilters, ...(clauses.length > 1 ? { AND: clauses } : clauses[0] || {}) };
};

router.get('/groups', async (req, res, next) => {
  try {
    const records = await prisma.accountingTransformationRecord.findMany({
      where: queryWhere(req),
      select: { recordType: true, accountingGroup: true, accountingGroupCode: true, overallProgress: true, censusProgress: true, inventoryProgress: true, valuationProgress: true },
    });
    const map = new Map();
    for (const item of records) {
      const group = accountingGroupKey(item);
      const current = map.get(group.key) || { key: group.key, label: group.label, code: group.code, count: 0, overallTotal: 0, censusTotal: 0, inventoryTotal: 0, valuationTotal: 0 };
      current.count += 1;
      current.overallTotal += Number(item.overallProgress || 0);
      current.censusTotal += Number(item.censusProgress || 0);
      current.inventoryTotal += Number(item.inventoryProgress || 0);
      current.valuationTotal += Number(item.valuationProgress || 0);
      map.set(group.key, current);
    }
    res.json(Array.from(map.values()).map((g) => ({
      key: g.key, label: g.label, code: g.code, count: g.count,
      averageOverall: Math.round(g.overallTotal / Math.max(1, g.count)),
      averageCensus: Math.round(g.censusTotal / Math.max(1, g.count)),
      averageInventory: Math.round(g.inventoryTotal / Math.max(1, g.count)),
      averageValuation: Math.round(g.valuationTotal / Math.max(1, g.count)),
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ar')));
  } catch (error) { next(error); }
});

router.get('/stats', async (req, res, next) => {
  try {
    const cycleId = normalizedText(req.query.cycleId);
    const cycleWhere = cycleId ? { cycleId } : { cycle: { isCurrent: true } };
    const [total, fixedAssets, lands, buildings, censusReady, inventoryReady, valuationReady, needsCompletion, underReview, averages] = await Promise.all([
      prisma.accountingTransformationRecord.count({ where: cycleWhere }),
      prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, recordType: 'fixed_asset' } }),
      prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, recordType: 'land' } }),
      prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, recordType: 'building' } }),
      prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, censusProgress: 100 } }),
      prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, inventoryProgress: 100 } }),
      prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, valuationProgress: 100 } }),
      prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, overallProgress: { lt: 100 } } }),
      prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, committeeStatus: 'under_review' } }),
      prisma.accountingTransformationRecord.aggregate({ where: cycleWhere, _avg: { censusProgress: true, inventoryProgress: true, valuationProgress: true, overallProgress: true } }),
    ]);
    res.json({
      total, fixedAssets, lands, buildings, censusReady, inventoryReady, valuationReady, needsCompletion, underReview,
      averageCensus: Math.round(Number(averages._avg.censusProgress || 0)),
      averageInventory: Math.round(Number(averages._avg.inventoryProgress || 0)),
      averageValuation: Math.round(Number(averages._avg.valuationProgress || 0)),
      averageOverall: Math.round(Number(averages._avg.overallProgress || 0)),
    });
  } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    const all = String(req.query.all || '') === '1';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = all ? 5000 : Math.min(200, Math.max(12, Number(req.query.limit) || 36));
    const where = queryWhere(req);
    const [total, items] = await Promise.all([
      prisma.accountingTransformationRecord.count({ where }),
      prisma.accountingTransformationRecord.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: all ? 0 : (page - 1) * limit, take: limit }),
    ]);
    res.json({ items, page: all ? 1 : page, limit, total, totalPages: all ? Math.ceil(total / limit) : Math.ceil(total / limit), truncated: all && total > limit });
  } catch (error) { next(error); }
});

router.post('/bulk-preview', async (req, res, next) => {
  try {
    const input = bulkImportSchema.parse(req.body);
    const fingerprints = [];
    const invalidIndexes = [];
    const seen = new Set();
    const duplicateIndexes = [];
    input.items.forEach((item, index) => {
      if (!itemIsValid(item)) { invalidIndexes.push(index); return; }
      const fingerprint = createAccountingFingerprint(item.recordType, item.payload || {});
      if (seen.has(fingerprint)) { duplicateIndexes.push(index); return; }
      seen.add(fingerprint);
      fingerprints.push({ index, fingerprint });
    });
    const existing = fingerprints.length ? await prisma.accountingTransformationRecord.findMany({
      where: { sourceFingerprint: { in: fingerprints.map((item) => item.fingerprint) } }, select: { sourceFingerprint: true },
    }) : [];
    const existingSet = new Set(existing.map((item) => item.sourceFingerprint).filter(Boolean));
    fingerprints.forEach((item) => { if (existingSet.has(item.fingerprint)) duplicateIndexes.push(item.index); });
    const duplicateSet = new Set(duplicateIndexes);
    const invalidSet = new Set(invalidIndexes);
    const freshIndexes = input.items.map((_, index) => index).filter((index) => !duplicateSet.has(index) && !invalidSet.has(index));
    res.json({ total: input.items.length, fresh: freshIndexes.length, duplicate: duplicateSet.size, invalid: invalidSet.size, freshIndexes, duplicateIndexes: Array.from(duplicateSet).sort((a, b) => a - b), invalidIndexes: Array.from(invalidSet).sort((a, b) => a - b) });
  } catch (error) { next(error); }
});

router.post('/bulk-import', async (req, res, next) => {
  try {
    const input = bulkImportSchema.parse(req.body);
    const currentCycle = await ensureAccountingTransformationBaseline();
    const baseNumber = await nextAccountingRecordNumber();
    const baseSequence = Number(baseNumber.split('-').pop()) || 1;
    const year = new Date().getFullYear();
    const rows = [];
    let skipped = 0;
    for (const item of input.items) {
      if (!itemIsValid(item)) { skipped += 1; continue; }
      const sourceFingerprint = createAccountingFingerprint(item.recordType, item.payload || {});
      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});
      const existing = await prisma.accountingTransformationRecord.findFirst({ where: { cycleId: currentCycle.id, sourceFingerprint }, select: { id: true } });
      if (existing) { skipped += 1; continue; }
      rows.push({
        ...buildAccountingSnapshotData(item, req.authUser, { cycleId: currentCycle.id, sourceFingerprint, stableKey, changeType: 'manual' }),
        recordNumber: `ACT-${year}-${String(baseSequence + rows.length).padStart(6, '0')}`,
        createdBy: req.authUser?.email || req.authUser?.username || null,
      });
    }
    for (let index = 0; index < rows.length; index += 750) await prisma.accountingTransformationRecord.createMany({ data: rows.slice(index, index + 750) });
    res.status(201).json({ created: rows.length, updated: 0, skipped, total: input.items.length });
  } catch (error) { next(error); }
});

router.get('/excel-template', async (_req, res, next) => {
  try {
    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY } });
    res.json(template || null);
  } catch (error) { next(error); }
});

router.post('/excel-template', officialAccountingExcelUpload.single('file'), async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'admin') return res.status(403).json({ message: 'رفع أو استبدال نموذج Excel الرسمي متاح لمسؤول النظام فقط.' });
    if (!req.file) return res.status(400).json({ message: 'لم يتم إرفاق نموذج Excel.' });
    const previous = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY } });
    const uploaded = await uploadBufferToGoogleDrive(req.file, { fileName: 'official-accounting-transformation-template.xlsx', mimeType: EXCEL_MIME });
    const uploadedBy = req.authUser?.email || req.authUser?.username || null;
    const template = await prisma.assetExcelTemplate.upsert({
      where: { templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY },
      update: { title: 'نموذج التحول المحاسبي الرسمي المعتمد', fileName: req.file.originalname || uploaded.fileName, driveFileId: uploaded.driveFileId, driveUrl: uploaded.driveUrl, mimeType: uploaded.mimeType || EXCEL_MIME, fileSize: req.file.size || null, uploadedBy },
      create: { templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY, title: 'نموذج التحول المحاسبي الرسمي المعتمد', fileName: req.file.originalname || uploaded.fileName, driveFileId: uploaded.driveFileId, driveUrl: uploaded.driveUrl, mimeType: uploaded.mimeType || EXCEL_MIME, fileSize: req.file.size || null, uploadedBy },
    });
    if (previous?.driveFileId && previous.driveFileId !== uploaded.driveFileId) {
      deleteGoogleDriveFile(previous.driveFileId).catch((error) => console.warn('Could not delete previous accounting Excel template:', error?.message || error));
    }
    await createAuditLog({ user: req.authUser, action: previous ? 'update' : 'create', module: 'accounting_transformation', entity: 'accounting_excel_template', entityId: template.id, entityLabel: template.fileName, description: previous ? 'استبدال نموذج Excel الرسمي للتحول المحاسبي' : 'رفع نموذج Excel الرسمي للتحول المحاسبي', newData: template, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(previous ? 200 : 201).json(template);
  } catch (error) { next(error); }
});

router.get('/excel-template/file', async (_req, res, next) => {
  try {
    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY } });
    if (!template) return res.status(404).json({ message: 'لم يتم رفع نموذج Excel الرسمي للتحول المحاسبي بعد.' });
    const downloaded = await downloadGoogleDriveFile(template.driveFileId);
    const safeName = String(template.fileName || downloaded.fileName || 'official-accounting-transformation-template.xlsx').replace(/[\"\r\n]/g, '_');
    res.setHeader('Content-Type', EXCEL_MIME);
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(safeName));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(downloaded.buffer);
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.accountingTransformationRecord.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    res.json(record);
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = recordInputSchema.parse(req.body);
    if (!itemIsValid(input)) return res.status(400).json({ message: 'السجل لا يحتوي على هوية أو وصف أصل كافٍ.' });
    const currentCycle = await ensureAccountingTransformationBaseline();
    const sourceFingerprint = createAccountingFingerprint(input.recordType, input.payload || {});
    const stableKey = createAccountingStableKey(input.recordType, input.payload || {});
    let record = null;
    for (let attempt = 0; attempt < 5 && !record; attempt += 1) {
      const recordNumber = await nextAccountingRecordNumber(attempt);
      try {
        record = await prisma.accountingTransformationRecord.create({
          data: {
            ...buildAccountingSnapshotData(input, req.authUser, { cycleId: currentCycle.id, sourceFingerprint, stableKey, changeType: 'manual' }),
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
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const input = recordInputSchema.parse(req.body);
    if (!itemIsValid(input)) return res.status(400).json({ message: 'السجل لا يحتوي على هوية أو وصف أصل كافٍ.' });
    const current = await prisma.accountingTransformationRecord.findUnique({ where: { id: req.params.id }, include: { cycle: true } });
    if (!current) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    if (current.cycle && current.cycle.status === 'archived') return res.status(409).json({ message: 'الدورات المؤرشفة للعرض التاريخي فقط ولا يمكن تعديل بياناتها' });
    const sourceFingerprint = createAccountingFingerprint(input.recordType, input.payload || {});
    const stableKey = createAccountingStableKey(input.recordType, input.payload || {});
    const record = await prisma.accountingTransformationRecord.update({
      where: { id: req.params.id },
      data: buildAccountingSnapshotData(input, req.authUser, { cycleId: current.cycleId, sourceFingerprint, stableKey, changeType: current.changeType || 'manual' }),
    });
    res.json(record);
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const current = await prisma.accountingTransformationRecord.findUnique({ where: { id: req.params.id }, include: { cycle: true } });
    if (!current) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    if (current.cycle && current.cycle.status === 'archived') return res.status(409).json({ message: 'الدورات المؤرشفة محفوظة كسجل تاريخي ولا يمكن حذف بياناتها' });
    await prisma.accountingTransformationRecord.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    if (error?.code === 'P2025') return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    next(error);
  }
});

export default router;
