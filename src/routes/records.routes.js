import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

const resources = {
  'allocated-lands': prisma.allocatedLand,
  'delivered-lands': prisma.deliveredLand,
  'leased-lands-out': prisma.leasedLandOut,
  'leased-lands-in': prisma.leasedLandIn,
  'leased-buildings-out': prisma.leasedBuildingOut,
  'leased-buildings-in': prisma.leasedBuildingIn,
};

const entityTypes = {
  'allocated-lands': 'allocated_land',
  'delivered-lands': 'delivered_land',
  'leased-lands-out': 'leased_land_out',
  'leased-lands-in': 'leased_land_in',
  'leased-buildings-out': 'leased_building_out',
  'leased-buildings-in': 'leased_building_in',
};

const allowedFields = {
  'allocated-lands': ['propertyDescription','plotNumber','planNumber','area','usageType','region','city','district','coordinates','googleEarthLink','notes','createdBy'],
  'delivered-lands': ['recipientEntity','deliveryDate','propertyDescription','plotNumber','planNumber','area','location','coordinates','deliveryMinutesNumber','notes','createdBy'],
  'leased-lands-out': ['tenant','contractNumber','contractStartDate','contractDuration','plotNumber','planNumber','area','location','coordinates','rentAmount','notes','createdBy'],
  'leased-lands-in': ['owner','contractNumber','contractDuration','propertyDescription','area','location','coordinates','rentAmount','notes','createdBy'],
  'leased-buildings-out': ['tenant','contractNumber','buildingNumber','planNumber','locationName','area','city','district','coordinates','rentAmount','notes','createdBy'],
  'leased-buildings-in': ['owner','contractNumber','buildingNumber','locationName','area','region','city','coordinates','rentAmount','notes','createdBy'],
};

const dateFields = new Set(['deliveryDate', 'contractStartDate']);
const numberFields = new Set(['area', 'rentAmount']);

const normalizeCoordinates = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && value.latitude !== undefined && value.longitude !== undefined) {
    const lat = Number(value.latitude);
    const lng = Number(value.longitude);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  }
  return null;
};

const mapFrontendPayload = (resource, body = {}) => {
  const mapped = { ...body };
  if (resource === 'delivered-lands') {
    mapped.deliveryDate = body.deliveryDate || body.receiptDate || null;
    mapped.propertyDescription = body.propertyDescription || body.description || body.landName || 'أرض مستلمة';
    mapped.deliveryMinutesNumber = body.deliveryMinutesNumber || body.receiptNumber || null;
    mapped.location = body.location || [body.region, body.city, body.district].filter(Boolean).join(' - ') || null;
  }
  return mapped;
};

const sanitizeRecordPayload = (resource, body = {}) => {
  const mapped = mapFrontendPayload(resource, body);
  const allowed = new Set(allowedFields[resource] || []);
  const data = {};
  for (const [key, value] of Object.entries(mapped)) {
    if (allowed.has(key)) data[key] = value;
  }

  if ('coordinates' in data) data.coordinates = normalizeCoordinates(data.coordinates);

  for (const field of dateFields) {
    if (field in data) data[field] = data[field] ? new Date(data[field]) : null;
  }

  for (const field of numberFields) {
    if (field in data) data[field] = data[field] === '' || data[field] == null ? null : Number(data[field]);
  }

  return data;
};

const sanitizeAttachments = (attachments, entityType, entityId) => {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a) => a?.driveUrl)
    .map((a) => ({
      entityType,
      entityId,
      attachmentType: a.attachmentType || 'other',
      title: String(a.title || a.fileName || a.originalName || 'مرفق').trim() || 'مرفق',
      driveUrl: String(a.driveUrl).trim(),
      driveFileId: a.driveFileId || null,
      mimeType: a.mimeType || a.fileType || null,
      notes: a.notes || null,
      createdBy: a.createdBy || null,
    }));
};

const getDelegate = (req, res) => {
  const delegate = resources[req.params.resource];
  if (!delegate) {
    res.status(404).json({ message: 'نوع السجل غير مدعوم' });
    return null;
  }
  return delegate;
};

const attachFilesToRecords = async (resource, records) => {
  const entityType = entityTypes[resource];
  if (!entityType || !records.length) return records;

  const attachments = await prisma.attachment.findMany({
    where: { entityType, entityId: { in: records.map((r) => r.id) } },
    orderBy: { createdAt: 'desc' },
  });

  const grouped = new Map();
  for (const attachment of attachments) {
    const current = grouped.get(attachment.entityId) || [];
    current.push(attachment);
    grouped.set(attachment.entityId, current);
  }

  return records.map((record) => ({
    ...record,
    attachments: grouped.get(record.id) || [],
  }));
};

router.get('/:resource', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;
    const records = await delegate.findMany({ orderBy: { updatedAt: 'desc' } });
    res.json(await attachFilesToRecords(req.params.resource, records));
  } catch (error) {
    next(error);
  }
});

router.post('/:resource', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;

    const resource = req.params.resource;
    const record = await delegate.create({
      data: sanitizeRecordPayload(resource, req.body),
    });

    const attachments = sanitizeAttachments(req.body?.attachments, entityTypes[resource], record.id);
    if (attachments.length) await prisma.attachment.createMany({ data: attachments });

    const [result] = await attachFilesToRecords(resource, [record]);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.put('/:resource/:id', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;

    const resource = req.params.resource;
    const record = await delegate.update({
      where: { id: req.params.id },
      data: sanitizeRecordPayload(resource, req.body),
    });

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'attachments')) {
      await prisma.attachment.deleteMany({
        where: { entityType: entityTypes[resource], entityId: req.params.id },
      });

      const attachments = sanitizeAttachments(req.body?.attachments, entityTypes[resource], req.params.id);
      if (attachments.length) await prisma.attachment.createMany({ data: attachments });
    }

    const [result] = await attachFilesToRecords(resource, [record]);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/:resource/:id', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;

    await prisma.attachment.deleteMany({
      where: { entityType: entityTypes[req.params.resource], entityId: req.params.id },
    });

    await delegate.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
