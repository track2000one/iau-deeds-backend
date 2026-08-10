import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';

const router = Router();

const nullableText = z.string().trim().max(5000).optional().nullable();
const nullableShortText = z.string().trim().max(500).optional().nullable();
const nullableNumber = z.coerce.number().min(0).optional().nullable();
const dateType = z.enum(['gregorian', 'hijri']).optional().default('gregorian');

const attachmentSchema = z.object({
  title: z.string().trim().min(1).max(500),
  driveUrl: z.string().url(),
  driveFileId: nullableShortText,
  mimeType: nullableShortText,
  notes: nullableShortText,
});

const assetSchema = z.object({
  itemNumber: z.string().trim().min(1, 'رقم الصنف مطلوب').max(150),
  barcode: nullableShortText,
  name: z.string().trim().min(1, 'اسم الأصل مطلوب').max(300),
  category: z.string().trim().min(1, 'تصنيف الأصل مطلوب').max(100),
  brand: nullableShortText,
  model: nullableShortText,
  serialNumber: nullableShortText,
  status: z.string().trim().max(100).default('available'),
  technicalCondition: nullableShortText,
  department: nullableShortText,
  building: nullableShortText,
  floor: nullableShortText,
  room: nullableShortText,
  entityName: nullableShortText,
  entityCode: nullableShortText,
  assetDescription: nullableText,
  cardNumber: nullableShortText,
  responsibleDepartment: nullableShortText,
  region: nullableShortText,
  city: nullableShortText,
  buildingNumber: nullableShortText,
  coordinates: nullableShortText,
  classification1: nullableShortText,
  classification2: nullableShortText,
  classification3: nullableShortText,
  classification4: nullableShortText,
  classification5: nullableShortText,
  classification6: nullableShortText,
  accountingGroup: nullableShortText,
  accountingGroupCode: nullableShortText,
  assetCode: nullableShortText,
  remainingLife: nullableNumber,
  usefulLife: nullableNumber,
  purchaseDate: z.string().trim().optional().nullable(),
  purchaseDateType: dateType,
  purchaseValue: nullableNumber,
  serviceDate: z.string().trim().optional().nullable(),
  serviceDateType: dateType,
  acquisitionCost: nullableNumber,
  supportingCostDocument: nullableShortText,
  archiveDocumentNumber: nullableShortText,
  manufacturer: nullableShortText,
  lastInventoryDate: z.string().trim().optional().nullable(),
  lastInventoryDateType: dateType,
  unitOfMeasure: nullableShortText,
  quantity: z.coerce.number().positive().optional().nullable().default(1),
  excelPayload: z.record(z.string(), z.any()).optional().nullable(),
  notes: nullableText,
  attachments: z.array(attachmentSchema).default([]),
});

const transferSchema = z.object({
  toDepartment: z.string().trim().min(1, 'الجهة / الإدارة الجديدة مطلوبة').max(500),
  toBuilding: nullableShortText,
  toFloor: nullableShortText,
  toRoom: nullableShortText,
  reason: nullableText,
  notes: nullableText,
});

const inventorySchema = z.object({
  method: z.enum(['barcode', 'camera', 'manual']),
  scannedBarcode: nullableShortText,
  result: z.string().trim().max(100).optional().default('matched'),
  department: nullableShortText,
  building: nullableShortText,
  floor: nullableShortText,
  room: nullableShortText,
  notes: nullableText,
});

const lossCaseSchema = z.object({
  caseNumber: z.string().trim().min(1, 'رقم المحضر مطلوب').max(150),
  minutesNumber: nullableShortText,
  minutesDate: z.string().trim().optional().nullable(),
  minutesDateType: dateType,
  department: nullableShortText,
  reason: z.string().trim().min(1, 'سبب العجز / الفقد مطلوب').max(5000),
  assetValue: nullableNumber,
  actionTaken: nullableText,
  notes: nullableText,
});

const toDate = (value, fieldName, type = 'gregorian') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (!match) {
      const error = new Error(`${fieldName} الهجري غير صحيح`);
      error.status = 400;
      throw error;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 30) {
      const error = new Error(`${fieldName} الهجري غير صحيح`);
      error.status = 400;
      throw error;
    }
    // Preserve the original Hijri year/month/day in the Date value for backward compatibility.
    // The companion *DateType field remains the source of truth for presentation.
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName} الميلادي غير صحيح`);
    error.status = 400;
    throw error;
  }
  return parsed;
};

const nextBarcode = async () => {
  const year = new Date().getFullYear();
  const prefix = `IAU-AST-${year}-`;
  const latest = await prisma.asset.findFirst({
    where: { barcode: { startsWith: prefix } },
    orderBy: { barcode: 'desc' },
    select: { barcode: true },
  });
  const last = latest?.barcode ? Number(String(latest.barcode).split('-').pop() || 0) : 0;
  return `${prefix}${String(last + 1).padStart(7, '0')}`;
};

const withAttachments = async (records) => {
  if (!records.length) return records;
  const attachments = await prisma.attachment.findMany({
    where: { entityType: 'asset', entityId: { in: records.map((record) => record.id) } },
    orderBy: { createdAt: 'desc' },
  });
  const grouped = new Map();
  for (const attachment of attachments) {
    const list = grouped.get(attachment.entityId) || [];
    list.push(attachment);
    grouped.set(attachment.entityId, list);
  }
  return records.map((record) => ({ ...record, attachments: grouped.get(record.id) || [] }));
};

const createAttachmentData = (attachment, assetId, createdBy) => ({
  entityType: 'asset',
  entityId: assetId,
  attachmentType: 'other',
  title: attachment.title,
  driveUrl: attachment.driveUrl,
  driveFileId: attachment.driveFileId || null,
  mimeType: attachment.mimeType || null,
  notes: attachment.notes || null,
  createdBy: createdBy || null,
});

const normalizeAssetData = (input, { barcode, purchaseDate, serviceDate, lastInventoryDate }) => ({
  assetNumber: input.itemNumber,
  itemNumber: input.itemNumber,
  barcode,
  name: input.name,
  category: input.category,
  brand: input.brand || null,
  model: input.model || null,
  serialNumber: input.serialNumber || null,
  status: input.status || 'available',
  technicalCondition: input.technicalCondition || null,
  department: input.department || input.responsibleDepartment || input.entityName || null,
  building: input.building || input.buildingNumber || null,
  floor: input.floor || null,
  room: input.room || null,
  custodian: null,
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
  remainingLife: input.remainingLife ?? null,
  usefulLife: input.usefulLife ?? null,
  purchaseDate,
  purchaseDateType: input.purchaseDateType,
  purchaseValue: input.purchaseValue ?? null,
  serviceDate,
  serviceDateType: input.serviceDateType,
  acquisitionCost: input.acquisitionCost ?? input.purchaseValue ?? null,
  supportingCostDocument: input.supportingCostDocument || null,
  archiveDocumentNumber: input.archiveDocumentNumber || null,
  manufacturer: input.manufacturer || input.brand || null,
  lastInventoryDate,
  lastInventoryDateType: input.lastInventoryDateType,
  unitOfMeasure: input.unitOfMeasure || null,
  quantity: input.quantity ?? 1,
  excelPayload: input.excelPayload || null,
  notes: input.notes || null,
});

router.get('/stats', async (_req, res, next) => {
  try {
    const [total, available, inUse, maintenance, lost, disposed, inventoryCount] = await Promise.all([
      prisma.asset.count(),
      prisma.asset.count({ where: { status: { in: ['available', 'active', 'stored'] } } }),
      prisma.asset.count({ where: { status: { in: ['in_use', 'assigned'] } } }),
      prisma.asset.count({ where: { status: 'maintenance' } }),
      prisma.asset.count({ where: { status: { in: ['lost', 'damaged'] } } }),
      prisma.asset.count({ where: { status: 'disposed' } }),
      prisma.assetInventoryEvent.count(),
    ]);
    res.json({ total, available, inUse, maintenance, lost, disposed, inventoryCount });
  } catch (error) {
    next(error);
  }
});

router.get('/lookup/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    const record = await prisma.asset.findFirst({
      where: { OR: [{ barcode: code }, { itemNumber: code }, { assetNumber: code }] },
    });
    if (!record) return res.status(404).json({ message: 'لم يتم العثور على أصل بهذا الرقم أو الباركود' });
    const [result] = await withAttachments([record]);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    const status = String(req.query.status || '').trim();
    const where = {
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(search ? {
        OR: [
          { itemNumber: { contains: search, mode: 'insensitive' } },
          { assetNumber: { contains: search, mode: 'insensitive' } },
          { barcode: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { serialNumber: { contains: search, mode: 'insensitive' } },
          { department: { contains: search, mode: 'insensitive' } },
          { building: { contains: search, mode: 'insensitive' } },
          { room: { contains: search, mode: 'insensitive' } },
          { responsibleDepartment: { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const records = await prisma.asset.findMany({ where, orderBy: [{ createdAt: 'desc' }] });
    res.json(await withAttachments(records));
  } catch (error) {
    next(error);
  }
});

router.get('/:id/movements', async (req, res, next) => {
  try {
    res.json(await prisma.assetMovement.findMany({ where: { assetId: req.params.id }, orderBy: { movedAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.post('/:id/transfer', async (req, res, next) => {
  try {
    const input = transferSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const movedBy = req.authUser?.username || req.authUser?.email || null;
    const result = await prisma.$transaction(async (tx) => {
      const movement = await tx.assetMovement.create({
        data: {
          assetId: existing.id,
          fromDepartment: existing.department,
          fromBuilding: existing.building,
          fromFloor: existing.floor,
          fromRoom: existing.room,
          toDepartment: input.toDepartment,
          toBuilding: input.toBuilding || null,
          toFloor: input.toFloor || null,
          toRoom: input.toRoom || null,
          reason: input.reason || null,
          notes: input.notes || null,
          movedBy,
        },
      });
      const asset = await tx.asset.update({
        where: { id: existing.id },
        data: {
          department: input.toDepartment,
          responsibleDepartment: input.toDepartment,
          entityName: input.toDepartment,
          building: input.toBuilding || null,
          buildingNumber: input.toBuilding || null,
          floor: input.toFloor || null,
          room: input.toRoom || null,
        },
      });
      return { movement, asset };
    });
    await createAuditLog({ user: req.authUser, action: 'transfer', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: 'نقل أصل بين المواقع / الجهات', previousData: existing, newData: result.asset, details: result.movement, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.get('/:id/inventory', async (req, res, next) => {
  try {
    res.json(await prisma.assetInventoryEvent.findMany({ where: { assetId: req.params.id }, orderBy: { scannedAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.post('/:id/inventory', async (req, res, next) => {
  try {
    const input = inventorySchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const scannedBy = req.authUser?.username || req.authUser?.email || null;
    const event = await prisma.$transaction(async (tx) => {
      const created = await tx.assetInventoryEvent.create({ data: { assetId: existing.id, ...input, scannedBy } });
      await tx.asset.update({ where: { id: existing.id }, data: { lastInventoryDate: new Date(), lastInventoryDateType: 'gregorian' } });
      return created;
    });
    await createAuditLog({ user: req.authUser, action: 'inventory', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: `جرد أصل بواسطة ${input.method}`, details: event, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(event);
  } catch (error) { next(error); }
});

router.get('/:id/loss-cases', async (req, res, next) => {
  try {
    res.json(await prisma.assetLossCase.findMany({ where: { assetId: req.params.id }, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.post('/:id/loss-cases', async (req, res, next) => {
  try {
    const input = lossCaseSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const duplicate = await prisma.assetLossCase.findUnique({ where: { caseNumber: input.caseNumber }, select: { id: true } });
    if (duplicate) return res.status(409).json({ message: 'رقم محضر العجز / الفقد مستخدم مسبقًا' });
    const createdBy = req.authUser?.username || req.authUser?.email || null;
    const lossCase = await prisma.$transaction(async (tx) => {
      const created = await tx.assetLossCase.create({
        data: {
          assetId: existing.id,
          caseNumber: input.caseNumber,
          minutesNumber: input.minutesNumber || input.caseNumber,
          minutesDate: toDate(input.minutesDate, 'تاريخ المحضر', input.minutesDateType),
          minutesDateType: input.minutesDateType,
          department: input.department || existing.department,
          reason: input.reason,
          assetValue: input.assetValue ?? existing.purchaseValue ?? existing.acquisitionCost ?? null,
          actionTaken: input.actionTaken || null,
          notes: input.notes || null,
          createdBy,
        },
      });
      await tx.asset.update({ where: { id: existing.id }, data: { status: 'lost' } });
      return created;
    });
    await createAuditLog({ user: req.authUser, action: 'loss_case', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: 'تسجيل عجز / فقد أصل', details: lossCase, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(lossCase);
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ message: 'الأصل غير موجود' });
    const [result] = await withAttachments([record]);
    const [movements, lossCases, inventoryEvents] = await Promise.all([
      prisma.assetMovement.findMany({ where: { assetId: record.id }, orderBy: { movedAt: 'desc' } }),
      prisma.assetLossCase.findMany({ where: { assetId: record.id }, orderBy: { createdAt: 'desc' } }),
      prisma.assetInventoryEvent.findMany({ where: { assetId: record.id }, orderBy: { scannedAt: 'desc' } }),
    ]);
    res.json({ ...result, movements, lossCases, inventoryEvents });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = assetSchema.parse(req.body);
    const duplicateItem = await prisma.asset.findFirst({ where: { OR: [{ itemNumber: input.itemNumber }, { assetNumber: input.itemNumber }] }, select: { id: true } });
    if (duplicateItem) return res.status(409).json({ message: 'رقم الصنف مستخدم لأصل آخر، يجب أن يكون رقمًا فريدًا' });
    const barcode = input.barcode || await nextBarcode();
    const duplicateBarcode = await prisma.asset.findFirst({ where: { barcode }, select: { id: true } });
    if (duplicateBarcode) return res.status(409).json({ message: 'رقم الباركود مستخدم لأصل آخر' });
    if (input.serialNumber) {
      const duplicateSerial = await prisma.asset.findFirst({ where: { serialNumber: input.serialNumber }, select: { id: true } });
      if (duplicateSerial) return res.status(409).json({ message: 'الرقم التسلسلي مستخدم لأصل آخر' });
    }
    const dates = {
      purchaseDate: toDate(input.purchaseDate, 'تاريخ الشراء', input.purchaseDateType),
      serviceDate: toDate(input.serviceDate, 'تاريخ الدخول في الخدمة', input.serviceDateType),
      lastInventoryDate: toDate(input.lastInventoryDate, 'تاريخ التحقق الميداني', input.lastInventoryDateType),
    };
    const createdBy = req.authUser?.username || req.authUser?.email || null;
    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({ data: { ...normalizeAssetData(input, { barcode, ...dates }), createdBy } });
      if (input.attachments.length) await tx.attachment.createMany({ data: input.attachments.map((attachment) => createAttachmentData(attachment, created.id, createdBy)) });
      return created;
    });
    await createAuditLog({ user: req.authUser, action: 'create', module: 'assets', entity: 'asset', entityId: record.id, entityLabel: record.itemNumber, description: 'إنشاء أصل جديد', newData: record, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    const [result] = await withAttachments([record]);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const input = assetSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const duplicateItem = await prisma.asset.findFirst({ where: { AND: [{ id: { not: existing.id } }, { OR: [{ itemNumber: input.itemNumber }, { assetNumber: input.itemNumber }] }] }, select: { id: true } });
    if (duplicateItem) return res.status(409).json({ message: 'رقم الصنف مستخدم لأصل آخر، يجب أن يكون رقمًا فريدًا' });
    const barcode = input.barcode || existing.barcode || await nextBarcode();
    const duplicateBarcode = await prisma.asset.findFirst({ where: { barcode, id: { not: existing.id } }, select: { id: true } });
    if (duplicateBarcode) return res.status(409).json({ message: 'رقم الباركود مستخدم لأصل آخر' });
    const dates = {
      purchaseDate: toDate(input.purchaseDate, 'تاريخ الشراء', input.purchaseDateType),
      serviceDate: toDate(input.serviceDate, 'تاريخ الدخول في الخدمة', input.serviceDateType),
      lastInventoryDate: toDate(input.lastInventoryDate, 'تاريخ التحقق الميداني', input.lastInventoryDateType),
    };
    const updatedBy = req.authUser?.username || req.authUser?.email || null;
    const updated = await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({ where: { entityType: 'asset', entityId: existing.id } });
      const record = await tx.asset.update({ where: { id: existing.id }, data: normalizeAssetData(input, { barcode, ...dates }) });
      if (input.attachments.length) await tx.attachment.createMany({ data: input.attachments.map((attachment) => createAttachmentData(attachment, record.id, updatedBy)) });
      return record;
    });
    await createAuditLog({ user: req.authUser, action: 'update', module: 'assets', entity: 'asset', entityId: updated.id, entityLabel: updated.itemNumber || updated.assetNumber, description: 'تحديث بيانات أصل', previousData: existing, newData: updated, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    const [result] = await withAttachments([updated]);
    res.json(result);
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({ where: { entityType: 'asset', entityId: existing.id } });
      await tx.asset.delete({ where: { id: existing.id } });
    });
    await createAuditLog({ user: req.authUser, action: 'delete', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: 'حذف أصل', previousData: existing, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(204).send();
  } catch (error) { next(error); }
});

export default router;
