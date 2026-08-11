import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import { uploadBufferToGoogleDrive, deleteGoogleDriveFile, downloadGoogleDriveFile } from '../services/googleDrive.js';

const router = Router();

const OFFICIAL_ASSET_TEMPLATE_KEY = 'official_assets_all';
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const officialExcelTemplateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    const allowed = file.mimetype === EXCEL_MIME || fileName.endsWith('.xlsx');
    cb(allowed ? null : new Error('القالب الرسمي يجب أن يكون ملف Excel بصيغة XLSX.'), allowed);
  },
});

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
  quantity: z.coerce.number().min(0, 'العدد لا يمكن أن يكون أقل من صفر').optional().nullable().default(1),
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

router.get('/excel-template', async (_req, res, next) => {
  try {
    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });
    res.json(template || null);
  } catch (error) { next(error); }
});

router.post('/excel-template', officialExcelTemplateUpload.single('file'), async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'admin') return res.status(403).json({ message: 'رفع أو استبدال قالب Excel الرسمي متاح لمسؤول النظام فقط.' });
    if (!req.file) return res.status(400).json({ message: 'لم يتم إرفاق قالب Excel.' });
    const previous = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });
    const uploaded = await uploadBufferToGoogleDrive(req.file, { fileName: 'official-assets-template.xlsx', mimeType: EXCEL_MIME });
    const uploadedBy = req.authUser?.username || req.authUser?.email || null;
    const template = await prisma.assetExcelTemplate.upsert({
      where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY },
      update: { title: 'نموذج الأصول الرسمي المعتمد', fileName: req.file.originalname || uploaded.fileName, driveFileId: uploaded.driveFileId, driveUrl: uploaded.driveUrl, mimeType: uploaded.mimeType || EXCEL_MIME, fileSize: req.file.size || null, uploadedBy },
      create: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY, title: 'نموذج الأصول الرسمي المعتمد', fileName: req.file.originalname || uploaded.fileName, driveFileId: uploaded.driveFileId, driveUrl: uploaded.driveUrl, mimeType: uploaded.mimeType || EXCEL_MIME, fileSize: req.file.size || null, uploadedBy },
    });
    if (previous?.driveFileId && previous.driveFileId !== uploaded.driveFileId) {
      deleteGoogleDriveFile(previous.driveFileId).catch((error) => console.warn('Could not delete previous asset Excel template:', error?.message || error));
    }
    await createAuditLog({ user: req.authUser, action: previous ? 'update' : 'create', module: 'assets', entity: 'asset_excel_template', entityId: template.id, entityLabel: template.fileName, description: previous ? 'استبدال قالب Excel الرسمي للأصول' : 'رفع قالب Excel الرسمي للأصول', newData: template, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(previous ? 200 : 201).json(template);
  } catch (error) { next(error); }
});

router.get('/excel-template/file', async (_req, res, next) => {
  try {
    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });
    if (!template) return res.status(404).json({ message: 'لم يتم رفع قالب Excel الرسمي للأصول بعد.' });
    const downloaded = await downloadGoogleDriveFile(template.driveFileId);
    const safeName = String(template.fileName || downloaded.fileName || 'official-assets-template.xlsx').replace(/[\"\r\n]/g, '_');
    res.setHeader('Content-Type', EXCEL_MIME);
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(safeName));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(downloaded.buffer);
  } catch (error) { next(error); }
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
      const created = await tx.assetInventoryEvent.create({ data: {
        assetId: existing.id,
        method: input.method,
        scannedBarcode: input.scannedBarcode || null,
        result: input.result || 'matched',
        department: input.department || existing.department,
        building: input.building || existing.building,
        floor: input.floor || existing.floor,
        room: input.room || existing.room,
        notes: input.notes || null,
        scannedBy,
      } });
      await tx.asset.update({ where: { id: existing.id }, data: { lastInventoryDate: new Date(), lastInventoryDateType: 'gregorian' } });
      return created;
    });
    await createAuditLog({ user: req.authUser, action: 'inventory', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: `جرد أصل بواسطة ${input.method}`, newData: event, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(event);
  } catch (error) { next(error); }
});

router.get('/:id/loss-cases', async (req, res, next) => {
  try { res.json(await prisma.assetLossCase.findMany({ where: { assetId: req.params.id }, orderBy: { createdAt: 'desc' } })); }
  catch (error) { next(error); }
});

router.post('/:id/loss-cases', async (req, res, next) => {
  try {
    const input = lossCaseSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const createdBy = req.authUser?.username || req.authUser?.email || null;
    const caseRecord = await prisma.$transaction(async (tx) => {
      const created = await tx.assetLossCase.create({ data: {
        assetId: existing.id,
        caseNumber: input.caseNumber,
        minutesNumber: input.minutesNumber || null,
        minutesDate: toDate(input.minutesDate, 'تاريخ المحضر', input.minutesDateType),
        minutesDateType: input.minutesDateType,
        department: input.department || existing.department,
        reason: input.reason,
        assetValue: input.assetValue ?? existing.acquisitionCost ?? existing.purchaseValue ?? null,
        actionTaken: input.actionTaken || null,
        notes: input.notes || null,
        createdBy,
      } });
      await tx.asset.update({ where: { id: existing.id }, data: { status: 'lost' } });
      return created;
    });
    await createAuditLog({ user: req.authUser, action: 'create', module: 'assets', entity: 'asset_loss_case', entityId: caseRecord.id, entityLabel: input.caseNumber, description: 'تسجيل عجز / فقد على أصل', newData: caseRecord, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(caseRecord);
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ message: 'الأصل غير موجود' });
    const [result] = await withAttachments([record]);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = assetSchema.parse(req.body);
    const duplicate = await prisma.asset.findUnique({ where: { itemNumber: input.itemNumber } });
    if (duplicate) return res.status(409).json({ message: 'رقم الصنف مستخدم مسبقًا ويجب أن يكون فريدًا' });
    let barcode = input.barcode?.trim() || '';
    if (!barcode) barcode = await nextBarcode();
    const barcodeDuplicate = await prisma.asset.findUnique({ where: { barcode } });
    if (barcodeDuplicate) return res.status(409).json({ message: 'الباركود مستخدم مسبقًا' });

    const purchaseDate = toDate(input.purchaseDate, 'تاريخ الشراء', input.purchaseDateType);
    const serviceDate = toDate(input.serviceDate, 'تاريخ الدخول في الخدمة', input.serviceDateType);
    const lastInventoryDate = toDate(input.lastInventoryDate, 'تاريخ الجرد', input.lastInventoryDateType);

    const createdBy = req.authUser?.username || req.authUser?.email || null;
    const result = await prisma.$transaction(async (tx) => {
      const record = await tx.asset.create({ data: normalizeAssetData(input, { barcode, purchaseDate, serviceDate, lastInventoryDate }) });
      if (input.attachments.length) {
        await tx.attachment.createMany({ data: input.attachments.map((attachment) => createAttachmentData(attachment, record.id, createdBy)) });
      }
      return record;
    });
    const [withFiles] = await withAttachments([result]);
    await createAuditLog({ user: req.authUser, action: 'create', module: 'assets', entity: 'asset', entityId: result.id, entityLabel: result.itemNumber || result.assetNumber, description: 'إضافة أصل جديد', newData: withFiles, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(withFiles);
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const input = assetSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const duplicate = await prisma.asset.findFirst({ where: { itemNumber: input.itemNumber, NOT: { id: existing.id } } });
    if (duplicate) return res.status(409).json({ message: 'رقم الصنف مستخدم مسبقًا ويجب أن يكون فريدًا' });
    let barcode = input.barcode?.trim() || existing.barcode || '';
    if (!barcode) barcode = await nextBarcode();
    const barcodeDuplicate = await prisma.asset.findFirst({ where: { barcode, NOT: { id: existing.id } } });
    if (barcodeDuplicate) return res.status(409).json({ message: 'الباركود مستخدم مسبقًا' });

    const purchaseDate = toDate(input.purchaseDate, 'تاريخ الشراء', input.purchaseDateType);
    const serviceDate = toDate(input.serviceDate, 'تاريخ الدخول في الخدمة', input.serviceDateType);
    const lastInventoryDate = toDate(input.lastInventoryDate, 'تاريخ الجرد', input.lastInventoryDateType);
    const createdBy = req.authUser?.username || req.authUser?.email || null;
    const result = await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({ where: { entityType: 'asset', entityId: existing.id } });
      const updateData = normalizeAssetData(input, { barcode, purchaseDate, serviceDate, lastInventoryDate });
      // createdAt is the immutable first-entry timestamp. Never allow edits/import refreshes to change it.
      const record = await tx.asset.update({ where: { id: existing.id }, data: { ...updateData, createdAt: existing.createdAt } });
      if (input.attachments.length) {
        await tx.attachment.createMany({ data: input.attachments.map((attachment) => createAttachmentData(attachment, record.id, createdBy)) });
      }
      return record;
    });
    const [withFiles] = await withAttachments([result]);
    await createAuditLog({ user: req.authUser, action: 'update', module: 'assets', entity: 'asset', entityId: result.id, entityLabel: result.itemNumber || result.assetNumber, description: 'تعديل بيانات أصل', previousData: existing, newData: withFiles, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.json(withFiles);
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const deletedBy = req.authUser?.username || req.authUser?.email || null;
    await prisma.$transaction([
      prisma.assetMovement.deleteMany({ where: { assetId: existing.id } }),
      prisma.assetInventoryEvent.deleteMany({ where: { assetId: existing.id } }),
      prisma.assetLossCase.deleteMany({ where: { assetId: existing.id } }),
      prisma.attachment.deleteMany({ where: { entityType: 'asset', entityId: existing.id } }),
      prisma.archiveRecord.create({ data: { entityType: 'asset', entityId: existing.id, documentType: 'أصل', documentNumber: existing.itemNumber || existing.assetNumber, title: existing.name, deletedData: existing, deletedBy } }),
      prisma.asset.delete({ where: { id: existing.id } }),
    ]);
    await createAuditLog({ user: req.authUser, action: 'delete', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: 'حذف أصل ونقله للأرشفة', previousData: existing, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(204).end();
  } catch (error) { next(error); }
});

export default router;
