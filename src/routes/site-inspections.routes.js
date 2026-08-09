import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';

const router = Router();

const nullableText = z.string().trim().max(5000).optional().nullable();
const nullableDate = z.string().trim().optional().nullable();

const itemSchema = z.object({
  id: z.string().optional(),
  category: z.string().trim().min(1, 'تصنيف الملاحظة مطلوب'),
  status: z.string().trim().default('good'),
  note: nullableText,
  priority: z.string().trim().default('normal'),
});

const attachmentSchema = z.object({
  title: z.string().trim().min(1).default('صورة معاينة'),
  driveUrl: z.string().url(),
  driveFileId: nullableText,
  mimeType: nullableText,
  notes: nullableText,
});

const inspectionSchema = z.object({
  title: z.string().trim().min(2, 'عنوان المعاينة مطلوب').max(300),
  siteType: z.string().trim().min(1, 'نوع الموقع مطلوب').max(100),
  siteName: z.string().trim().min(1, 'اسم الموقع مطلوب').max(300),
  visitDate: z.string().trim().min(1, 'تاريخ الزيارة مطلوب'),
  visitDateType: z.enum(['gregorian', 'hijri']).optional().default('gregorian'),
  visitPurpose: nullableText,
  inspectorName: nullableText,
  accompanyingEntity: nullableText,
  region: nullableText,
  city: nullableText,
  district: nullableText,
  locationDescription: nullableText,
  deedNumber: nullableText,
  plotNumber: nullableText,
  planNumber: nullableText,
  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  locationAccuracy: z.coerce.number().min(0).optional().nullable(),
  mapUrl: nullableText,
  overallStatus: z.string().trim().default('good'),
  priority: z.string().trim().default('normal'),
  observations: nullableText,
  recommendedAction: nullableText,
  referredEntity: nullableText,
  followUpDate: nullableDate,
  followUpDateType: z.enum(['gregorian', 'hijri']).optional().default('gregorian'),
  workflowStatus: z.string().trim().default('new'),
  items: z.array(itemSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
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

const makeMapUrl = (latitude, longitude, suppliedUrl) => {
  if (suppliedUrl) return suppliedUrl;
  if (latitude == null || longitude == null) return null;
  return `https://www.google.com/maps?q=${latitude},${longitude}`;
};

const nextInspectionNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `INS-${year}-`;

  const latest = await prisma.siteInspection.findFirst({
    where: { inspectionNumber: { startsWith: prefix } },
    orderBy: { inspectionNumber: 'desc' },
    select: { inspectionNumber: true },
  });

  const lastSequence = latest
    ? Number(latest.inspectionNumber.split('-').pop() || 0)
    : 0;

  return `${prefix}${String(lastSequence + 1).padStart(5, '0')}`;
};

const withAttachments = async (records) => {
  if (!records.length) return records;

  const attachments = await prisma.attachment.findMany({
    where: {
      entityType: 'site_inspection',
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

const createAttachmentData = (attachment, inspectionId, createdBy) => ({
  entityType: 'site_inspection',
  entityId: inspectionId,
  attachmentType: 'inspection_image',
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
    const workflowStatus = String(req.query.workflowStatus || '').trim();
    const siteType = String(req.query.siteType || '').trim();

    const where = {
      ...(workflowStatus ? { workflowStatus } : {}),
      ...(siteType ? { siteType } : {}),
      ...(search
        ? {
            OR: [
              { inspectionNumber: { contains: search, mode: 'insensitive' } },
              { title: { contains: search, mode: 'insensitive' } },
              { siteName: { contains: search, mode: 'insensitive' } },
              { city: { contains: search, mode: 'insensitive' } },
              { observations: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const records = await prisma.siteInspection.findMany({
      where,
      include: { items: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ visitDate: 'desc' }, { createdAt: 'desc' }],
    });

    res.json(await withAttachments(records));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.siteInspection.findUnique({
      where: { id: req.params.id },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });

    if (!record) {
      return res.status(404).json({ message: 'المعاينة الميدانية غير موجودة' });
    }

    const [result] = await withAttachments([record]);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = inspectionSchema.parse(req.body);
    const inspectionNumber = await nextInspectionNumber();
    const visitDate = toDate(input.visitDate, 'تاريخ الزيارة', input.visitDateType);
    const followUpDate = toDate(input.followUpDate, 'تاريخ المتابعة', input.followUpDateType);
    const createdBy = req.authUser?.username || req.authUser?.email || null;

    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.siteInspection.create({
        data: {
          inspectionNumber,
          title: input.title,
          siteType: input.siteType,
          siteName: input.siteName,
          visitDate,
          visitDateType: input.visitDateType,
          visitPurpose: input.visitPurpose || null,
          inspectorName: input.inspectorName || createdBy,
          accompanyingEntity: input.accompanyingEntity || null,
          region: input.region || null,
          city: input.city || null,
          district: input.district || null,
          locationDescription: input.locationDescription || null,
          deedNumber: input.deedNumber || null,
          plotNumber: input.plotNumber || null,
          planNumber: input.planNumber || null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          locationAccuracy: input.locationAccuracy ?? null,
          mapUrl: makeMapUrl(input.latitude, input.longitude, input.mapUrl),
          overallStatus: input.overallStatus,
          priority: input.priority,
          observations: input.observations || null,
          recommendedAction: input.recommendedAction || null,
          referredEntity: input.referredEntity || null,
          followUpDate,
          followUpDateType: input.followUpDateType,
          workflowStatus: input.workflowStatus,
          createdBy,
          items: {
            create: input.items.map((item) => ({
              category: item.category,
              status: item.status,
              note: item.note || null,
              priority: item.priority,
            })),
          },
        },
        include: { items: true },
      });

      if (input.attachments.length) {
        await tx.attachment.createMany({
          data: input.attachments.map((attachment) =>
            createAttachmentData(attachment, created.id, createdBy)
          ),
        });
      }

      return created;
    });

    await createAuditLog({
      user: req.authUser,
      action: 'create',
      module: 'site_inspections',
      entity: 'site_inspection',
      entityId: record.id,
      entityLabel: record.inspectionNumber,
      description: 'إنشاء معاينة ميدانية',
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
    const input = inspectionSchema.parse(req.body);
    const existing = await prisma.siteInspection.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });

    if (!existing) {
      return res.status(404).json({ message: 'المعاينة الميدانية غير موجودة' });
    }

    const visitDate = toDate(input.visitDate, 'تاريخ الزيارة', input.visitDateType);
    const followUpDate = toDate(input.followUpDate, 'تاريخ المتابعة', input.followUpDateType);
    const createdBy = req.authUser?.username || req.authUser?.email || null;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.siteInspectionItem.deleteMany({
        where: { inspectionId: req.params.id },
      });

      await tx.attachment.deleteMany({
        where: {
          entityType: 'site_inspection',
          entityId: req.params.id,
        },
      });

      const record = await tx.siteInspection.update({
        where: { id: req.params.id },
        data: {
          title: input.title,
          siteType: input.siteType,
          siteName: input.siteName,
          visitDate,
          visitDateType: input.visitDateType,
          visitPurpose: input.visitPurpose || null,
          inspectorName: input.inspectorName || createdBy,
          accompanyingEntity: input.accompanyingEntity || null,
          region: input.region || null,
          city: input.city || null,
          district: input.district || null,
          locationDescription: input.locationDescription || null,
          deedNumber: input.deedNumber || null,
          plotNumber: input.plotNumber || null,
          planNumber: input.planNumber || null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          locationAccuracy: input.locationAccuracy ?? null,
          mapUrl: makeMapUrl(input.latitude, input.longitude, input.mapUrl),
          overallStatus: input.overallStatus,
          priority: input.priority,
          observations: input.observations || null,
          recommendedAction: input.recommendedAction || null,
          referredEntity: input.referredEntity || null,
          followUpDate,
          followUpDateType: input.followUpDateType,
          workflowStatus: input.workflowStatus,
          items: {
            create: input.items.map((item) => ({
              category: item.category,
              status: item.status,
              note: item.note || null,
              priority: item.priority,
            })),
          },
        },
        include: { items: true },
      });

      if (input.attachments.length) {
        await tx.attachment.createMany({
          data: input.attachments.map((attachment) =>
            createAttachmentData(attachment, record.id, createdBy)
          ),
        });
      }

      return record;
    });

    await createAuditLog({
      user: req.authUser,
      action: 'update',
      module: 'site_inspections',
      entity: 'site_inspection',
      entityId: updated.id,
      entityLabel: updated.inspectionNumber,
      description: 'تحديث معاينة ميدانية',
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
    const existing = await prisma.siteInspection.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      return res.status(404).json({ message: 'المعاينة الميدانية غير موجودة' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({
        where: {
          entityType: 'site_inspection',
          entityId: req.params.id,
        },
      });

      await tx.siteInspection.delete({
        where: { id: req.params.id },
      });
    });

    await createAuditLog({
      user: req.authUser,
      action: 'delete',
      module: 'site_inspections',
      entity: 'site_inspection',
      entityId: existing.id,
      entityLabel: existing.inspectionNumber,
      description: 'حذف معاينة ميدانية',
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
