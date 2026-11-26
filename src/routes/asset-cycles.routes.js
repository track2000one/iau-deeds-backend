import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import {
  assetCycleRecordData,
  assetSnapshotFromAsset,
  compareAssetSnapshots,
  createAssetFingerprint,
  createAssetStableKey,
  ensureAssetBaselineCycle,
  getAssetCycleComparison,
  mergeAssetCycleSnapshots,
  normalizeAssetCycleInput,
} from '../services/assetCycles.service.js';

const router = Router();

const cycleInputSchema = z.object({
  name: z.string().trim().min(3, 'اسم دورة التحديث مطلوب').max(180),
  description: z.string().trim().max(1500).nullable().optional(),
});

const importRowSchema = z.object({
  input: z.record(z.string(), z.unknown()),
  sourceFile: z.string().trim().max(300).nullable().optional(),
  sourceFileHash: z.string().trim().max(300).nullable().optional(),
  sourceSheet: z.string().trim().max(300).nullable().optional(),
  sourceRow: z.coerce.number().int().positive().nullable().optional(),
});

const importSchema = z.object({
  items: z.array(importRowSchema).min(1).max(1000),
  sourceFileNames: z.array(z.string().trim().max(300)).max(30).optional().default([]),
});

const userLabel = (req) => req.authUser?.email || req.authUser?.username || null;
const assetPermission = (req) => req.authUser?.permissions?.find((item) => item.module === 'assets');
const canEditCycles = (req) => req.authUser?.role === 'admin' || Boolean(assetPermission(req)?.canEdit);
const canApproveCycles = (req) => req.authUser?.role === 'admin' || Boolean(assetPermission(req)?.canApproveCycle);

const serializeCycle = (cycle, comparison = null) => ({
  ...cycle,
  recordCount: cycle?._count?.records ?? cycle?.recordCount ?? 0,
  _count: undefined,
  comparison,
});

const getCycleOr404 = async (req, res) => {
  const cycle = await prisma.assetUpdateCycle.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { records: true } } },
  });
  if (!cycle) {
    res.status(404).json({ message: 'دورة تحديث الأصول غير موجودة' });
    return null;
  }
  return cycle;
};

const assertDraftCycle = (cycle, res) => {
  if (cycle.status !== 'draft' || cycle.isCurrent) {
    res.status(409).json({
      message: cycle.status === 'under_review'
        ? 'الدورة تحت المراجعة ومجمّدة. أعدها إلى المسودة قبل تعديل بياناتها.'
        : 'لا يمكن تعديل هذه الدورة بعد اعتمادها أو أرشفتها.',
    });
    return false;
  }
  return true;
};

const isExcelIdentifierHeader = (value) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ').replace(/[ـ\u064B-\u065F\u0670]/g, '').toLowerCase();
  return /^(رقم الأصل الفريد بالجهة(?:\s*\(.*\))?|رقم الأصل الفريد في نظام وزارة المالية(?:\s*\(.*\))?|رقم الصنف|رقم الأصل|unique asset number in the entity|unique asset number in mof system|item number|asset number)$/.test(text);
};

const isSnapshotValid = (snapshot) => Boolean(
  String(snapshot.itemNumber || '').trim() &&
  !isExcelIdentifierHeader(snapshot.itemNumber) &&
  String(snapshot.name || '').trim() &&
  String(snapshot.category || '').trim()
);

const parseDateForDb = (value, type = 'gregorian') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (!match) return null;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const nextBarcode = async (tx) => {
  const year = new Date().getFullYear();
  const prefix = `IAU-AST-${year}-`;
  const latest = await tx.asset.findFirst({
    where: { barcode: { startsWith: prefix } },
    orderBy: { barcode: 'desc' },
    select: { barcode: true },
  });
  const last = latest?.barcode ? Number(String(latest.barcode).split('-').pop() || 0) : 0;
  return `${prefix}${String(last + 1).padStart(7, '0')}`;
};

const snapshotToDbData = (snapshotInput, existing, meta, barcode) => {
  const input = normalizeAssetCycleInput(snapshotInput);
  const itemNumber = String(input.itemNumber || '').trim();
  return {
    assetNumber: itemNumber,
    itemNumber,
    barcode,
    name: String(input.name || '').trim(),
    category: String(input.category || 'other').trim() || 'other',
    brand: input.brand || null,
    model: input.model || null,
    serialNumber: input.serialNumber || null,
    status: input.status || 'available',
    technicalCondition: input.technicalCondition || null,
    department: input.department || input.responsibleDepartment || input.entityName || null,
    building: input.building || input.buildingNumber || null,
    floor: input.floor || null,
    room: input.room || null,
    custodian: existing?.custodian || null,
    entityName: input.entityName || input.department || null,
    entityCode: input.entityCode || null,
    assetDescription: input.assetDescription || null,
    cardNumber: input.cardNumber || null,
    responsibleDepartment: input.responsibleDepartment || input.department || null,
    region: input.region || null,
    city: input.city || null,
    buildingNumber: input.buildingNumber || input.building || null,
    coordinates: input.coordinates || null,
    classification1: input.classification1 || null,
    classification2: input.classification2 || null,
    classification3: input.classification3 || null,
    classification4: input.classification4 || null,
    classification5: input.classification5 || null,
    classification6: input.classification6 || null,
    accountingGroup: input.accountingGroup || null,
    accountingGroupCode: input.accountingGroupCode || null,
    assetCode: input.assetCode || null,
    remainingLife: input.remainingLife == null ? null : Number(input.remainingLife),
    usefulLife: input.usefulLife == null ? null : Number(input.usefulLife),
    purchaseDate: parseDateForDb(input.purchaseDate, input.purchaseDateType),
    purchaseDateType: input.purchaseDateType || 'gregorian',
    purchaseValue: input.purchaseValue == null ? null : Number(input.purchaseValue),
    vatRate: input.vatRate == null ? 15 : Number(input.vatRate),
    vatAmount: input.vatAmount == null ? null : Number(input.vatAmount),
    purchaseValueBeforeVat: input.purchaseValueBeforeVat == null ? null : Number(input.purchaseValueBeforeVat),
    purchaseValueIncludingVat: input.purchaseValueIncludingVat == null ? null : Number(input.purchaseValueIncludingVat),
    serviceDate: parseDateForDb(input.serviceDate, input.serviceDateType),
    serviceDateType: input.serviceDateType || 'gregorian',
    acquisitionCost: input.acquisitionCost == null ? null : Number(input.acquisitionCost),
    supportingCostDocument: input.supportingCostDocument || null,
    archiveDocumentNumber: input.archiveDocumentNumber || null,
    manufacturer: input.manufacturer || input.brand || null,
    lastInventoryDate: parseDateForDb(input.lastInventoryDate, input.lastInventoryDateType),
    lastInventoryDateType: input.lastInventoryDateType || 'gregorian',
    unitOfMeasure: input.unitOfMeasure || null,
    quantity: input.quantity == null ? 1 : Number(input.quantity),
    excelPayload: input.excelPayload || null,
    notes: input.notes || null,
    stableKey: meta.stableKey,
    isInCurrentCycle: true,
    cycleState: meta.changeType || 'current',
    lastApprovedCycleId: meta.cycleId,
  };
};

const findLiveAssetForRecord = async (tx, record) => {
  if (record.assetId) {
    const byId = await tx.asset.findUnique({ where: { id: record.assetId } });
    if (byId) return byId;
  }
  const candidates = [
    ['stableKey', record.stableKey],
    ['itemNumber', record.itemNumber],
    ['barcode', record.barcode],
    ['serialNumber', record.serialNumber],
    ['cardNumber', record.cardNumber],
  ].filter(([, value]) => String(value || '').trim());
  if (!candidates.length) return null;
  return tx.asset.findFirst({
    where: { OR: candidates.map(([key, value]) => ({ [key]: value })) },
    orderBy: { updatedAt: 'desc' },
  });
};

const carryForwardUnchangedAssetRecords = async (cycle, db = prisma) => {
  if (!cycle.basedOnCycleId) return 0;
  const [baseRecords, targetRecords] = await Promise.all([
    db.assetCycleRecord.findMany({ where: { cycleId: cycle.basedOnCycleId } }),
    db.assetCycleRecord.findMany({ where: { cycleId: cycle.id }, select: { stableKey: true } }),
  ]);
  const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));
  const carryRows = baseRecords
    .filter((record) => record.stableKey && !targetKeys.has(record.stableKey))
    .map((record) => {
      const { id, cycleId: _cycleId, createdAt, updatedAt, ...rest } = record;
      return {
        ...rest,
        cycleId: cycle.id,
        changeType: 'unchanged',
        reviewStatus: rest.reviewStatus === 'needs_review' ? 'needs_review' : 'auto',
        previousRecordId: id,
        reviewedAt: null,
        reviewedBy: null,
      };
    });
  for (let index = 0; index < carryRows.length; index += 750) {
    await db.assetCycleRecord.createMany({ data: carryRows.slice(index, index + 750) });
  }
  return carryRows.length;
};


router.get('/', async (_req, res, next) => {
  try {
    await ensureAssetBaselineCycle();
    const cycles = await prisma.assetUpdateCycle.findMany({
      orderBy: { cycleNumber: 'desc' },
      include: { _count: { select: { records: true } } },
    });
    const response = await Promise.all(
      cycles.map(async (cycle) => serializeCycle(cycle, await getAssetCycleComparison(cycle)))
    );
    res.json(response);
  } catch (error) { next(error); }
});

router.get('/current', async (_req, res, next) => {
  try {
    const current = await ensureAssetBaselineCycle();
    const cycle = await prisma.assetUpdateCycle.findUnique({
      where: { id: current.id }, include: { _count: { select: { records: true } } },
    });
    res.json(serializeCycle(cycle, await getAssetCycleComparison(cycle)));
  } catch (error) { next(error); }
});

router.get('/:id/comparison', async (req, res, next) => {
  try {
    const cycle = await getCycleOr404(req, res);
    if (!cycle) return;
    res.json(await getAssetCycleComparison(cycle));
  } catch (error) { next(error); }
});

router.get('/:id/records', async (req, res, next) => {
  try {
    const cycle = await getCycleOr404(req, res);
    if (!cycle) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(500, Math.max(20, Number(req.query.limit) || 50));
    const search = String(req.query.search || '').trim();
    const changeType = String(req.query.changeType || '').trim();
    const reviewStatus = String(req.query.reviewStatus || '').trim();
    const where = {
      cycleId: cycle.id,
      ...(changeType && changeType !== 'all' ? { changeType } : {}),
      ...(reviewStatus && reviewStatus !== 'all' ? { reviewStatus } : {}),
      ...(search ? { OR: [
        { itemNumber: { contains: search, mode: 'insensitive' } },
        { barcode: { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { department: { contains: search, mode: 'insensitive' } },
        { building: { contains: search, mode: 'insensitive' } },
      ] } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.assetCycleRecord.count({ where }),
      prisma.assetCycleRecord.findMany({ where, orderBy: [{ changeType: 'asc' }, { name: 'asc' }], skip: (page - 1) * limit, take: limit }),
    ]);
    res.json({ items, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = cycleInputSchema.parse(req.body);
    const current = await ensureAssetBaselineCycle();
    const openCycle = await prisma.assetUpdateCycle.findFirst({
      where: { status: { in: ['draft', 'under_review'] } }, orderBy: { cycleNumber: 'desc' },
    });
    if (openCycle) return res.status(409).json({
      message: `توجد دورة تحديث مفتوحة بالفعل: ${openCycle.name}. أكملها أو احذفها قبل إنشاء دورة جديدة.`, cycleId: openCycle.id,
    });
    const max = await prisma.assetUpdateCycle.aggregate({ _max: { cycleNumber: true } });
    const cycle = await prisma.assetUpdateCycle.create({
      data: {
        cycleNumber: Number(max._max.cycleNumber || 0) + 1,
        name: input.name,
        description: input.description || null,
        status: 'draft', isCurrent: false, basedOnCycleId: current.id, createdBy: userLabel(req),
      },
      include: { _count: { select: { records: true } } },
    });
    await createAuditLog({
      user: req.authUser, action: 'create_cycle', module: 'assets', entity: 'asset_cycle', entityId: cycle.id,
      entityLabel: cycle.name, description: 'إنشاء دورة تحديث جديدة لبيانات الأصول', newData: cycle,
      ipAddress: getClientIp(req), userAgent: req.headers['user-agent'],
    });
    res.status(201).json(serializeCycle(cycle));
  } catch (error) { next(error); }
});

router.post('/:id/import-preview', async (req, res, next) => {
  try {
    const input = importSchema.parse(req.body);
    const cycle = await getCycleOr404(req, res);
    if (!cycle || !assertDraftCycle(cycle, res)) return;
    const baseRecords = cycle.basedOnCycleId ? await prisma.assetCycleRecord.findMany({
      where: { cycleId: cycle.basedOnCycleId }, select: { stableKey: true, sourceFingerprint: true, payload: true },
    }) : [];
    const baseByKey = new Map(baseRecords.filter((item) => item.stableKey).map((item) => [item.stableKey, item]));
    const targetRecords = await prisma.assetCycleRecord.findMany({ where: { cycleId: cycle.id }, select: { stableKey: true } });
    const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));
    const seen = new Set();
    const result = { total: input.items.length, fresh: 0, duplicate: 0, invalid: 0, new: 0, modified: 0, unchanged: 0, needsReview: 0 };
    for (const row of input.items) {
      const incomingSnapshot = normalizeAssetCycleInput(row.input);
      const identity = createAssetStableKey(incomingSnapshot);
      const previous = baseByKey.get(identity.key);
      const snapshot = previous ? mergeAssetCycleSnapshots(previous.payload || {}, row.input) : incomingSnapshot;
      if (!isSnapshotValid(snapshot)) { result.invalid += 1; continue; }
      const fingerprint = createAssetFingerprint(snapshot);
      if (seen.has(identity.key) || targetKeys.has(identity.key)) { result.duplicate += 1; continue; }
      seen.add(identity.key);
      result.fresh += 1;
      if (!previous) result.new += 1;
      else if (previous.sourceFingerprint === fingerprint) result.unchanged += 1;
      else result.modified += 1;
      if (identity.confidence === 'fallback') result.needsReview += 1;
    }
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/:id/import', async (req, res, next) => {
  try {
    const input = importSchema.parse(req.body);
    const cycle = await getCycleOr404(req, res);
    if (!cycle || !assertDraftCycle(cycle, res)) return;
    const baseRecords = cycle.basedOnCycleId ? await prisma.assetCycleRecord.findMany({
      where: { cycleId: cycle.basedOnCycleId },
      select: { id: true, stableKey: true, sourceFingerprint: true, payload: true, assetId: true },
    }) : [];
    const baseByKey = new Map(baseRecords.filter((item) => item.stableKey).map((item) => [item.stableKey, item]));
    const existingTarget = await prisma.assetCycleRecord.findMany({ where: { cycleId: cycle.id }, select: { stableKey: true } });
    const targetKeys = new Set(existingTarget.map((item) => item.stableKey).filter(Boolean));
    const seen = new Set();
    const createdRows = [];
    let skipped = 0;
    let invalid = 0;
    let createdNew = 0;
    let createdModified = 0;
    let createdUnchanged = 0;
    let needsReview = 0;

    for (const row of input.items) {
      const incomingSnapshot = normalizeAssetCycleInput(row.input);
      const identity = createAssetStableKey(incomingSnapshot);
      if (seen.has(identity.key) || targetKeys.has(identity.key)) { skipped += 1; continue; }
      const previous = baseByKey.get(identity.key);
      const snapshot = previous ? mergeAssetCycleSnapshots(previous.payload || {}, row.input) : incomingSnapshot;
      if (!isSnapshotValid(snapshot)) { invalid += 1; continue; }
      seen.add(identity.key);
      const fingerprint = createAssetFingerprint(snapshot);
      const changeType = !previous ? 'new' : previous.sourceFingerprint === fingerprint ? 'unchanged' : 'modified';
      const changedFields = previous && changeType === 'modified' ? compareAssetSnapshots(previous.payload || {}, snapshot) : [];
      const reviewStatus = identity.confidence === 'fallback' ? 'needs_review' : 'auto';
      if (reviewStatus === 'needs_review') needsReview += 1;
      createdRows.push({
        cycleId: cycle.id,
        ...assetCycleRecordData(snapshot, {
          stableKey: identity.key,
          sourceFingerprint: fingerprint,
          changeType,
          reviewStatus,
          previousRecordId: previous?.id || null,
          assetId: previous?.assetId || null,
          changedFields,
          sourceFileName: row.sourceFile || null,
          sourceFileHash: row.sourceFileHash || null,
          sourceSheet: row.sourceSheet || null,
          sourceRow: row.sourceRow || null,
        }),
      });
      targetKeys.add(identity.key);
      if (changeType === 'new') createdNew += 1;
      else if (changeType === 'modified') createdModified += 1;
      else createdUnchanged += 1;
    }

    if (createdRows.length) await prisma.assetCycleRecord.createMany({ data: createdRows });
    const oldFiles = Array.isArray(cycle.sourceFileNames) ? cycle.sourceFileNames : [];
    const sourceFileNames = Array.from(new Set([...oldFiles, ...input.sourceFileNames, ...input.items.map((row) => row.sourceFile).filter(Boolean)]));
    const updatedCycle = await prisma.assetUpdateCycle.update({
      where: { id: cycle.id },
      data: { sourceFileNames, importedAt: new Date(), importedBy: userLabel(req) },
      include: { _count: { select: { records: true } } },
    });
    await createAuditLog({
      user: req.authUser, action: 'cycle_import', module: 'assets', entity: 'asset_cycle', entityId: cycle.id,
      entityLabel: cycle.name, description: `استيراد ${createdRows.length} سجل إلى مسودة دورة الأصول`,
      newData: { created: createdRows.length, skipped, invalid, new: createdNew, modified: createdModified, unchanged: createdUnchanged, needsReview },
      ipAddress: getClientIp(req), userAgent: req.headers['user-agent'],
    });
    res.status(201).json({
      created: createdRows.length, skipped, invalid, total: input.items.length,
      new: createdNew, modified: createdModified, unchanged: createdUnchanged, needsReview,
      cycle: serializeCycle(updatedCycle), comparison: await getAssetCycleComparison(updatedCycle),
    });
  } catch (error) { next(error); }
});

router.patch('/:id/records/:recordId/confirm', async (req, res, next) => {
  try {
    if (!canEditCycles(req)) return res.status(403).json({ message: 'تأكيد السجل يتطلب صلاحية التعديل.' });
    const cycle = await getCycleOr404(req, res);
    if (!cycle || !['draft', 'under_review'].includes(cycle.status) || cycle.isCurrent) return res.status(409).json({ message: 'لا يمكن تعديل مراجعة هذا السجل في دورة مغلقة.' });
    const record = await prisma.assetCycleRecord.findFirst({ where: { id: req.params.recordId, cycleId: cycle.id } });
    if (!record) return res.status(404).json({ message: 'سجل الدورة غير موجود.' });
    const updated = await prisma.assetCycleRecord.update({ where: { id: record.id }, data: { reviewStatus: 'reviewed', reviewedBy: userLabel(req), reviewedAt: new Date() } });
    res.json(updated);
  } catch (error) { next(error); }
});

router.post('/:id/review', async (req, res, next) => {
  try {
    if (!canEditCycles(req)) return res.status(403).json({ message: 'إرسال الدورة للمراجعة يتطلب صلاحية التعديل.' });
    const cycle = await getCycleOr404(req, res);
    if (!cycle || !assertDraftCycle(cycle, res)) return;
    if (!cycle._count.records) return res.status(409).json({ message: 'لا يمكن إرسال دورة فارغة للمراجعة.' });
    const updated = await prisma.assetUpdateCycle.update({
      where: { id: cycle.id }, data: { status: 'under_review', reviewedAt: new Date(), reviewedBy: userLabel(req) },
      include: { _count: { select: { records: true } } },
    });
    res.json(serializeCycle(updated, await getAssetCycleComparison(updated)));
  } catch (error) { next(error); }
});

router.post('/:id/reopen', async (req, res, next) => {
  try {
    if (!canEditCycles(req)) return res.status(403).json({ message: 'إعادة الدورة للمسودة تتطلب صلاحية التعديل.' });
    const cycle = await getCycleOr404(req, res);
    if (!cycle || cycle.isCurrent || cycle.status !== 'under_review') return res.status(409).json({ message: 'يمكن إعادة الدورات تحت المراجعة فقط.' });
    const updated = await prisma.assetUpdateCycle.update({ where: { id: cycle.id }, data: { status: 'draft' }, include: { _count: { select: { records: true } } } });
    res.json(serializeCycle(updated, await getAssetCycleComparison(updated)));
  } catch (error) { next(error); }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    if (!canApproveCycles(req)) return res.status(403).json({ message: 'اعتماد دورة الأصول يتطلب صلاحية «اعتماد دورة».' });
    const cycle = await getCycleOr404(req, res);
    if (!cycle) return;
    if (cycle.status !== 'under_review' || cycle.isCurrent) return res.status(409).json({ message: 'يجب إرسال الدورة للمراجعة قبل اعتمادها.' });
    if (!cycle._count.records) return res.status(409).json({ message: 'لا يمكن اعتماد دورة لا تحتوي على بيانات.' });
    const approvedAt = new Date();
    const approvedBy = userLabel(req);
    const conflict = (message) => Object.assign(new Error(message), { status: 409 });
    let carriedForward = 0;

    await prisma.$transaction(async (tx) => {
      // All changes, including carry-forward, are committed together.
      // A short lock prevents parallel approval/import/asset writes from racing
      // with identity matching or barcode allocation; normal reads remain available.
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`LOCK TABLE "AssetUpdateCycle", "AssetCycleRecord", "Asset" IN SHARE ROW EXCLUSIVE MODE`;
      const locked = await tx.assetUpdateCycle.findUnique({ where: { id: cycle.id } });
      if (!locked || locked.status !== 'under_review' || locked.isCurrent) {
        throw conflict('تغيرت حالة الدورة. حدّث الصفحة للتحقق من نتيجة الاعتماد.');
      }

      carriedForward = await carryForwardUnchangedAssetRecords(locked, tx);
      const pendingReview = await tx.assetCycleRecord.count({ where: { cycleId: cycle.id, reviewStatus: 'needs_review' } });
      if (pendingReview) throw conflict(`يوجد ${pendingReview} سجل يحتاج مراجعة وتأكيد قبل اعتماد الدورة.`);
      const records = await tx.assetCycleRecord.findMany({ where: { cycleId: cycle.id } });
      if (!records.length) throw conflict('لا يمكن اعتماد دورة لا تحتوي على بيانات.');
      const baseRecords = locked.basedOnCycleId ? await tx.assetCycleRecord.findMany({
        where: { cycleId: locked.basedOnCycleId },
        select: { assetId: true, stableKey: true, itemNumber: true, barcode: true, serialNumber: true, cardNumber: true },
      }) : [];
      const targetKeys = new Set(records.map((record) => record.stableKey));
      const removedRecords = baseRecords.filter((record) => record.stableKey && !targetKeys.has(record.stableKey));

      // Preload current identities once, using the same ID-first then latest
      // matching identity policy as findLiveAssetForRecord.
      const live = await tx.asset.findMany({ orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
      const byId = new Map(live.map((asset) => [asset.id, asset]));
      const matchFields = ['stableKey', 'itemNumber', 'barcode', 'serialNumber', 'cardNumber'];
      const indices = new Map(matchFields.map((field) => [field, new Map()]));
      const rank = new Map(live.map((asset, index) => [asset.id, index]));
      for (const asset of live) {
        for (const field of matchFields) {
          const value = asset[field];
          if (String(value || '').trim() && !indices.get(field).has(value)) indices.get(field).set(value, asset);
        }
      }
      const matchLive = (record) => {
        if (record.assetId && byId.has(record.assetId)) return byId.get(record.assetId);
        let best = null;
        for (const field of matchFields) {
          const value = record[field];
          if (!String(value || '').trim()) continue;
          const candidate = indices.get(field).get(value);
          if (candidate && (!best || rank.get(candidate.id) < rank.get(best.id))) best = candidate;
        }
        return best;
      };

      const barcodePrefix = `IAU-AST-${approvedAt.getFullYear()}-`;
      const reservedBarcodes = new Set(live.map((asset) => asset.barcode).filter(Boolean));
      for (const record of records) {
        const barcode = String(record.payload?.barcode || record.barcode || '').trim();
        if (barcode) reservedBarcodes.add(barcode);
      }
      let barcodeSequence = 0;
      for (const barcode of reservedBarcodes) {
        if (barcode.startsWith(barcodePrefix)) barcodeSequence = Math.max(barcodeSequence, Number(barcode.slice(barcodePrefix.length)) || 0);
      }
      const allocateBarcode = () => {
        let barcode;
        do { barcode = barcodePrefix + String(++barcodeSequence).padStart(7, '0'); } while (reservedBarcodes.has(barcode));
        reservedBarcodes.add(barcode);
        return barcode;
      };

      const inserts = [], updates = [], metadataOnly = [], recordLinks = [];
      const insertRecordIds = new Map();
      const plannedRecords = [];
      const usedAssetRecords = new Map();
      const uniqueFields = [['assetNumber', 'رقم الأصل'], ['itemNumber', 'رقم الصنف'], ['barcode', 'الباركود'], ['serialNumber', 'الرقم التسلسلي']];
      const currentOwners = new Map(uniqueFields.map(([field]) => [field, new Map(live.filter((asset) => asset[field] != null).map((asset) => [asset[field], asset]))]));
      const describeRecord = (record) => `${record.itemNumber || 'بلا رقم صنف'} — ${record.name || 'أصل غير مسمى'}${record.sourceRow ? ` (صف Excel ${record.sourceRow}${record.sourceSheet ? `، ورقة ${record.sourceSheet}` : ''})` : ''}`;
      const describeAsset = (asset) => `${asset.itemNumber || asset.assetNumber || 'بلا رقم'} — ${asset.name || 'أصل غير مسمى'}`;
      const activeAssetIds = new Set();
      for (const record of records) {
        const snapshot = normalizeAssetCycleInput(record.payload || {});
        if (isExcelIdentifierHeader(snapshot.itemNumber)) {
          throw conflict(`رقم الصنف في السجل «${describeRecord(record)}» هو عنوان عمود Excel وليس معرف أصل صالحًا. يلزم مراجعة الصف المستورد قبل الاعتماد؛ لم تُحذف أو تُعدّل البيانات.`);
        }
        if (!isSnapshotValid(snapshot)) throw conflict(`السجل «${describeRecord(record)}» لا يحتوي على الحقول الأساسية المطلوبة.`);
        const existing = matchLive(record);
        const id = existing?.id;
        if (id && activeAssetIds.has(id)) throw conflict(`تعارض مطابقة: السجل «${describeRecord(record)}» والسجل «${describeRecord(usedAssetRecords.get(id))}» يطابقان الأصل نفسه «${describeAsset(existing)}». لم يتم اعتماد الدورة.`);
        if (id) { activeAssetIds.add(id); usedAssetRecords.set(id, record); }
        const barcode = String(snapshot.barcode || existing?.barcode || '').trim() || allocateBarcode();
        const data = snapshotToDbData(snapshot, existing, { stableKey: record.stableKey, cycleId: cycle.id, changeType: record.changeType }, barcode);
        // assetNumber is a separate, unique legacy identifier. Do not rewrite
        // an already assigned asset number when importing a new item number.
        if (existing?.assetNumber != null && String(existing.assetNumber).trim()) data.assetNumber = existing.assetNumber;
        const fingerprint = existing ? createAssetFingerprint(assetSnapshotFromAsset(existing)) : null;
        const mustUpdate = !existing || fingerprint !== record.sourceFingerprint || !existing.isInCurrentCycle || existing.stableKey !== record.stableKey;
        plannedRecords.push({ id, record, data: mustUpdate ? data : existing });
        if (!existing) {
          if (insertRecordIds.has(data.itemNumber)) {
            const prior = plannedRecords.find((plan) => plan.record.id === insertRecordIds.get(data.itemNumber));
            throw conflict(`تعارض رقم الصنف «${data.itemNumber}» بين «${describeRecord(record)}» و«${describeRecord(prior.record)}». لم يتم اعتماد الدورة.`);
          }
          insertRecordIds.set(data.itemNumber, record.id);
          inserts.push({ ...data, createdBy: approvedBy });
        } else {
          if (mustUpdate) updates.push({ id, ...data });
          else metadataOnly.push({ id, cycleState: data.cycleState });
        }
        if (id && record.assetId !== id) recordLinks.push({ id: record.id, assetId: id });
      }

      // Detect unique-value collisions before executing any live asset writes.
      // Keep every source record and never silently renumber, merge or delete.
      const plannedOwners = new Map(uniqueFields.map(([field]) => [field, new Map()]));
      for (const plan of plannedRecords) {
        for (const [field, label] of uniqueFields) {
          const value = plan.data[field];
          if (value == null) continue;
          const prior = plannedOwners.get(field).get(value);
          if (prior && prior.record.id !== plan.record.id) {
            throw conflict(`تعارض في ${label} «${value}»: السجل «${describeRecord(plan.record)}» والسجل «${describeRecord(prior.record)}». لم يتم اعتماد الدورة ولم تتغير بيانات الأصول.`);
          }
          plannedOwners.get(field).set(value, plan);
          const owner = currentOwners.get(field).get(value);
          if (owner && owner.id !== plan.id) {
            throw conflict(`تعارض في ${label} «${value}»: السجل «${describeRecord(plan.record)}» والقيمة مستخدمة في الأصل الحالي «${describeAsset(owner)}». يلزم مراجعة المطابقة قبل الاعتماد. لم تتغير بيانات الأصول.`);
          }
        }
      }

      // PostgreSQL typed recordsets perform batch updates without thousands of
      // individual round trips. Values are bound parameters, not SQL strings.
      for (let offset = 0; offset < updates.length; offset += 250) {
        const payload = JSON.stringify(updates.slice(offset, offset + 250));
        await tx.$executeRaw`UPDATE "Asset" AS a
          SET "assetNumber" = v."assetNumber",
              "itemNumber" = v."itemNumber",
              "barcode" = v."barcode",
              "name" = v."name",
              "category" = v."category",
              "brand" = v."brand",
              "model" = v."model",
              "serialNumber" = v."serialNumber",
              "status" = v."status",
              "technicalCondition" = v."technicalCondition",
              "department" = v."department",
              "building" = v."building",
              "floor" = v."floor",
              "room" = v."room",
              "custodian" = v."custodian",
              "entityName" = v."entityName",
              "entityCode" = v."entityCode",
              "assetDescription" = v."assetDescription",
              "cardNumber" = v."cardNumber",
              "responsibleDepartment" = v."responsibleDepartment",
              "region" = v."region",
              "city" = v."city",
              "buildingNumber" = v."buildingNumber",
              "coordinates" = v."coordinates",
              "classification1" = v."classification1",
              "classification2" = v."classification2",
              "classification3" = v."classification3",
              "classification4" = v."classification4",
              "classification5" = v."classification5",
              "classification6" = v."classification6",
              "accountingGroup" = v."accountingGroup",
              "accountingGroupCode" = v."accountingGroupCode",
              "assetCode" = v."assetCode",
              "remainingLife" = v."remainingLife",
              "usefulLife" = v."usefulLife",
              "purchaseDate" = v."purchaseDate",
              "purchaseDateType" = v."purchaseDateType",
              "purchaseValue" = v."purchaseValue",
              "vatRate" = v."vatRate",
              "vatAmount" = v."vatAmount",
              "purchaseValueBeforeVat" = v."purchaseValueBeforeVat",
              "purchaseValueIncludingVat" = v."purchaseValueIncludingVat",
              "serviceDate" = v."serviceDate",
              "serviceDateType" = v."serviceDateType",
              "acquisitionCost" = v."acquisitionCost",
              "supportingCostDocument" = v."supportingCostDocument",
              "archiveDocumentNumber" = v."archiveDocumentNumber",
              "manufacturer" = v."manufacturer",
              "lastInventoryDate" = v."lastInventoryDate",
              "lastInventoryDateType" = v."lastInventoryDateType",
              "unitOfMeasure" = v."unitOfMeasure",
              "quantity" = v."quantity",
              "excelPayload" = v."excelPayload",
              "notes" = v."notes",
              "stableKey" = v."stableKey",
              "isInCurrentCycle" = v."isInCurrentCycle",
              "cycleState" = v."cycleState",
              "lastApprovedCycleId" = v."lastApprovedCycleId",
              "updatedAt" = CURRENT_TIMESTAMP
          FROM jsonb_populate_recordset(NULL::"Asset", ${payload}::jsonb) AS v
          WHERE a.id = v.id`;
      }
      for (let offset = 0; offset < inserts.length; offset += 250) {
        const created = await tx.asset.createManyAndReturn({
          data: inserts.slice(offset, offset + 250), select: { id: true, itemNumber: true },
        });
        for (const asset of created) {
          const recordId = insertRecordIds.get(asset.itemNumber);
          if (!recordId) throw new Error('Unable to resolve created asset identity');
          activeAssetIds.add(asset.id);
          recordLinks.push({ id: recordId, assetId: asset.id });
        }
      }
      for (let offset = 0; offset < metadataOnly.length; offset += 750) {
        const payload = JSON.stringify(metadataOnly.slice(offset, offset + 750));
        await tx.$executeRaw`UPDATE "Asset" AS a
          SET "lastApprovedCycleId" = ${cycle.id}, "cycleState" = v."cycleState",
              "isInCurrentCycle" = true, "updatedAt" = CURRENT_TIMESTAMP
          FROM jsonb_to_recordset(${payload}::jsonb) AS v(id text, "cycleState" text)
          WHERE a.id = v.id`;
      }
      for (let offset = 0; offset < recordLinks.length; offset += 750) {
        const links = JSON.stringify(recordLinks.slice(offset, offset + 750));
        await tx.$executeRaw`UPDATE "AssetCycleRecord" AS r
          SET "assetId" = v."assetId", "updatedAt" = CURRENT_TIMESTAMP
          FROM jsonb_to_recordset(${links}::jsonb) AS v(id text, "assetId" text)
          WHERE r.id = v.id AND r."cycleId" = ${cycle.id}`;
      }

      const missingIds = [...new Set(removedRecords.map(matchLive).filter(Boolean).map((asset) => asset.id).filter((id) => !activeAssetIds.has(id)))];
      for (let offset = 0; offset < missingIds.length; offset += 750) {
        await tx.asset.updateMany({
          where: { id: { in: missingIds.slice(offset, offset + 750) } },
          data: { isInCurrentCycle: false, cycleState: 'missing' },
        });
      }
      await tx.assetUpdateCycle.updateMany({
        where: { isCurrent: true, id: { not: cycle.id } },
        data: { isCurrent: false, status: 'archived', archivedAt: approvedAt },
      });
      await tx.assetUpdateCycle.update({
        where: { id: cycle.id },
        data: { isCurrent: true, status: 'approved', approvedAt, approvedBy },
      });
    }, { maxWait: 15000, timeout: 120000 });

    const comparison = await getAssetCycleComparison(cycle);
    const updated = await prisma.assetUpdateCycle.findUnique({ where: { id: cycle.id }, include: { _count: { select: { records: true } } } });
    await createAuditLog({
      user: req.authUser, action: 'approve_cycle', module: 'assets', entity: 'asset_cycle', entityId: cycle.id,
      entityLabel: cycle.name, description: 'اعتماد دورة تحديث الأصول وجعلها البيانات الحالية',
      newData: { cycle: updated, comparison, carriedForward }, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'],
    });
    res.json({ cycle: serializeCycle(updated), comparison });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const cycle = await getCycleOr404(req, res);
    if (!cycle) return;
    if (cycle.isCurrent || !['draft', 'under_review'].includes(cycle.status)) return res.status(409).json({ message: 'لا يمكن حذف دورة معتمدة أو مؤرشفة؛ تبقى محفوظة كسجل تاريخي.' });
    await prisma.assetUpdateCycle.delete({ where: { id: cycle.id } });
    res.status(204).send();
  } catch (error) { next(error); }
});

export default router;
