import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';

const router = Router();

const nullableText = z.string().trim().max(5000).optional().nullable();
const nullableShortText = z.string().trim().max(500).optional().nullable();

const attachmentSchema = z.object({
  title: z.string().trim().min(1).max(500),
  driveUrl: z.string().url(),
  driveFileId: nullableShortText,
  mimeType: nullableShortText,
  notes: nullableShortText,
});

const assetSchema = z.object({
  barcode: nullableShortText,
  name: z.string().trim().min(1, 'اسم الأصل مطلوب').max(300),
  category: z.string().trim().min(1, 'تصنيف الأصل مطلوب').max(100),
  brand: nullableShortText,
  model: nullableShortText,
  serialNumber: nullableShortText,
  status: z.string().trim().max(100).default('active'),
  department: nullableShortText,
  building: nullableShortText,
  floor: nullableShortText,
  room: nullableShortText,
  custodian: nullableShortText,
  purchaseDate: z.string().trim().optional().nullable(),
  purchaseValue: z.coerce.number().min(0).optional().nullable(),
  notes: nullableText,
  attachments: z.array(attachmentSchema).default([]),
});

const toDate = (value, fieldName) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName} غير صحيح`);
    error.status = 400;
    throw error;
  }
  return parsed;
};

const nextAssetNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `AST-${year}-`;

  const latest = await prisma.asset.findFirst({
    where: { assetNumber: { startsWith: prefix } },
    orderBy: { assetNumber: 'desc' },
    select: { assetNumber: true },
  });

  const lastSequence = latest
    ? Number(latest.assetNumber.split('-').pop() || 0)
    : 0;

  return `${prefix}${String(lastSequence + 1).padStart(6, '0')}`;
};

const withAttachments = async (records) => {
  if (!records.length) return records;

  const attachments = await prisma.attachment.findMany({
    where: {
      entityType: 'asset',
      entityId: { in: records.map((record) => record.id) },
    },
    orderBy: { createdAt: 'desc' },
  });

  const grouped = new Map();
  for (const attachment of attachments) {
    const list = grouped.get(attachment.entityId) || [];
    list.push(attachment);
    grouped.set(attachment.entityId, list);
  }

  return records.map((record) => ({
    ...record,
    attachments: grouped.get(record.id) || [],
  }));
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

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    const status = String(req.query.status || '').trim();

    const where = {
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { assetNumber: { contains: search, mode: 'insensitive' } },
              { barcode: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { serialNumber: { contains: search, mode: 'insensitive' } },
              { department: { contains: search, mode: 'insensitive' } },
              { building: { contains: search, mode: 'insensitive' } },
              { room: { contains: search, mode: 'insensitive' } },
              { custodian: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const records = await prisma.asset.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
    });

    res.json(await withAttachments(records));
  } catch (error) {
    next(error);
  }
});

router.get('/stats', async (_req, res, next) => {
  try {
    const [total, inCustody, maintenance, excluded] = await Promise.all([
      prisma.asset.count(),
      prisma.asset.count({ where: { custodian: { not: null } } }),
      prisma.asset.count({ where: { status: 'maintenance' } }),
      prisma.asset.count({ where: { status: 'disposed' } }),
    ]);

    res.json({ total, inCustody, maintenance, excluded });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ message: 'الأصل غير موجود' });
    const [result] = await withAttachments([record]);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = assetSchema.parse(req.body);
    const assetNumber = await nextAssetNumber();
    const purchaseDate = toDate(input.purchaseDate, 'تاريخ الشراء');
    const createdBy = req.authUser?.username || req.authUser?.email || null;

    if (input.barcode) {
      const duplicateBarcode = await prisma.asset.findFirst({ where: { barcode: input.barcode }, select: { id: true } });
      if (duplicateBarcode) return res.status(409).json({ message: 'رقم الباركود مستخدم لأصل آخر' });
    }

    if (input.serialNumber) {
      const duplicateSerial = await prisma.asset.findFirst({ where: { serialNumber: input.serialNumber }, select: { id: true } });
      if (duplicateSerial) return res.status(409).json({ message: 'الرقم التسلسلي مستخدم لأصل آخر' });
    }

    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({
        data: {
          assetNumber,
          barcode: input.barcode || null,
          name: input.name,
          category: input.category,
          brand: input.brand || null,
          model: input.model || null,
          serialNumber: input.serialNumber || null,
          status: input.status,
          department: input.department || null,
          building: input.building || null,
          floor: input.floor || null,
          room: input.room || null,
          custodian: input.custodian || null,
          purchaseDate,
          purchaseValue: input.purchaseValue ?? null,
          notes: input.notes || null,
          createdBy,
        },
      });

      if (input.attachments.length) {
        await tx.attachment.createMany({
          data: input.attachments.map((attachment) => createAttachmentData(attachment, created.id, createdBy)),
        });
      }

      return created;
    });

    await createAuditLog({
      user: req.authUser,
      action: 'create',
      module: 'assets',
      entity: 'asset',
      entityId: record.id,
      entityLabel: record.assetNumber,
      description: 'إنشاء أصل جديد',
      newData: record,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    const [result] = await withAttachments([record]);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const input = assetSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });

    const purchaseDate = toDate(input.purchaseDate, 'تاريخ الشراء');
    const updatedBy = req.authUser?.username || req.authUser?.email || null;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({ where: { entityType: 'asset', entityId: req.params.id } });

      const record = await tx.asset.update({
        where: { id: req.params.id },
        data: {
          barcode: input.barcode || null,
          name: input.name,
          category: input.category,
          brand: input.brand || null,
          model: input.model || null,
          serialNumber: input.serialNumber || null,
          status: input.status,
          department: input.department || null,
          building: input.building || null,
          floor: input.floor || null,
          room: input.room || null,
          custodian: input.custodian || null,
          purchaseDate,
          purchaseValue: input.purchaseValue ?? null,
          notes: input.notes || null,
        },
      });

      if (input.attachments.length) {
        await tx.attachment.createMany({
          data: input.attachments.map((attachment) => createAttachmentData(attachment, record.id, updatedBy)),
        });
      }

      return record;
    });

    await createAuditLog({
      user: req.authUser,
      action: 'update',
      module: 'assets',
      entity: 'asset',
      entityId: updated.id,
      entityLabel: updated.assetNumber,
      description: 'تحديث بيانات أصل',
      previousData: existing,
      newData: updated,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    const [result] = await withAttachments([updated]);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });

    await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({ where: { entityType: 'asset', entityId: req.params.id } });
      await tx.asset.delete({ where: { id: req.params.id } });
    });

    await createAuditLog({
      user: req.authUser,
      action: 'delete',
      module: 'assets',
      entity: 'asset',
      entityId: existing.id,
      entityLabel: existing.assetNumber,
      description: 'حذف أصل',
      previousData: existing,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
