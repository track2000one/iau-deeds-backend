import express from 'express';
import { prisma } from '../prisma.js';

const router = express.Router();

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
  'allocated-lands': ['propertyDescription','plotNumber','planNumber','area','usageType','region','city','district','coordinates','googleEarthLink','notes'],
  'delivered-lands': [
    'receiptNumber',
    'receiptDate',
    'receiptDateType',
    'deliveryDate',
    'deliveryDateType',
    'deliveringEntity',
    'recipientEntity',
    'landName',
    'description',
    'propertyDescription',
    'region',
    'city',
    'district',
    'plotNumber',
    'planNumber',
    'area',
    'usageType',
    'status',
    'hasRelatedDeed',
    'relatedDeedNumber',
    'location',
    'coordinates',
    'deliveryMinutesNumber',
    'notes',
  ],
  'leased-lands-out': ['tenant','contractNumber','contractStartDate','contractStartDateOriginal','contractStartDateType','contractEndDate','contractEndDateOriginal','contractEndDateType','contractDuration','plotNumber','planNumber','area','location','coordinates','rentAmount','notes'],
  'leased-lands-in': ['owner','contractNumber','contractStartDate','contractStartDateOriginal','contractStartDateType','contractEndDate','contractEndDateOriginal','contractEndDateType','contractDuration','propertyDescription','area','location','coordinates','rentAmount','notes'],
  'leased-buildings-out': ['tenant','contractNumber','contractStartDate','contractStartDateOriginal','contractStartDateType','contractEndDate','contractEndDateOriginal','contractEndDateType','buildingNumber','planNumber','locationName','area','city','district','coordinates','rentAmount','notes'],
  'leased-buildings-in': ['owner','contractNumber','contractStartDate','contractStartDateOriginal','contractStartDateType','contractEndDate','contractEndDateOriginal','contractEndDateType','buildingNumber','locationName','area','region','city','coordinates','rentAmount','notes'],
};

const dateFields = new Set([
  'receiptDate',
  'deliveryDate',
  'contractStartDate',
  'contractEndDate',
]);
const numberFields = new Set(['area', 'rentAmount']);

const hijriParts = (date) => {
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
    year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC'
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
};

const hijriToGregorian = (year, month, day) => {
  const roughYear = year + 579;
  const center = Date.UTC(roughYear, Math.max(0, month - 1), Math.min(day, 28), 12, 0, 0);
  for (let offset = -420; offset <= 420; offset += 1) {
    const candidate = new Date(center + offset * 86400000);
    const h = hijriParts(candidate);
    if (h.year === year && h.month === month && h.day === day) return candidate;
  }
  return null;
};

const parseFlexibleDate = (value, type = 'gregorian') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 30) return null;
    return hijriToGregorian(year, month, day);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeCoordinates = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && value.latitude !== undefined && value.longitude !== undefined) {
    const lat = Number(value.latitude);
    const lng = Number(value.longitude);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
  }
  return null;
};

const mapFrontendPayload = (resource, body = {}) => {
  const mapped = { ...body };

  if (resource === 'delivered-lands') {
    mapped.receiptNumber =
      body.receiptNumber || body.deliveryMinutesNumber || null;
    mapped.deliveryMinutesNumber =
      body.deliveryMinutesNumber || body.receiptNumber || null;

    mapped.receiptDate =
      body.receiptDate || body.deliveryDate || null;
    mapped.deliveryDate =
      body.deliveryDate || body.receiptDate || null;

    mapped.receiptDateType =
      body.receiptDateType || body.deliveryDateType || 'gregorian';
    mapped.deliveryDateType =
      body.deliveryDateType || body.receiptDateType || 'gregorian';

    mapped.description =
      body.description || body.propertyDescription || body.landName || '';
    mapped.propertyDescription =
      body.propertyDescription || body.description || body.landName || 'أرض مستلمة';

    mapped.landName =
      body.landName || body.propertyDescription || body.description || '';

    mapped.location =
      body.location ||
      [body.region, body.city, body.district].filter(Boolean).join(' - ') ||
      null;

    mapped.hasRelatedDeed = Boolean(body.hasRelatedDeed);
    mapped.relatedDeedNumber = body.hasRelatedDeed
      ? body.relatedDeedNumber || null
      : null;
  }

  if (['leased-lands-out', 'leased-lands-in', 'leased-buildings-out', 'leased-buildings-in'].includes(resource)) {
    for (const field of ['contractStartDate', 'contractEndDate']) {
      const typeField = `${field}Type`;
      const originalField = `${field}Original`;
      const type = body[typeField] === 'hijri' ? 'hijri' : 'gregorian';
      const original = body[originalField] || body[field] || null;
      mapped[typeField] = type;
      mapped[originalField] = original;
      mapped[field] = original;
    }
  }

  if (resource === 'leased-lands-in') {
    mapped.propertyDescription =
      body.propertyDescription ||
      body.location ||
      [body.plotNumber, body.planNumber].filter(Boolean).join(' - ') ||
      'أرض مستأجرة';
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
    if (field in data) {
      const typeField = `${field}Type`;
      const dateType = mapped[typeField] === 'hijri' ? 'hijri' : 'gregorian';
      data[field] = parseFlexibleDate(data[field], dateType);
    }
  }

  for (const field of numberFields) {
    if (field in data) {
      const parsed = data[field] === '' || data[field] == null ? null : Number(data[field]);
      data[field] = parsed === null || Number.isNaN(parsed) ? null : parsed;
    }
  }

  return data;
};

const sanitizeAttachments = (attachments, entityType, entityId, createdBy = null) => {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((attachment) => attachment?.driveUrl)
    .map((attachment) => ({
      entityType,
      entityId,
      attachmentType: attachment.attachmentType || 'other',
      title: String(
        attachment.title ||
        attachment.fileName ||
        attachment.originalName ||
        'مرفق'
      ).trim() || 'مرفق',
      driveUrl: String(attachment.driveUrl).trim(),
      driveFileId: attachment.driveFileId || null,
      mimeType: attachment.mimeType || attachment.fileType || null,
      notes: attachment.notes || null,
      createdBy,
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
    where: {
      entityType,
      entityId: { in: records.map((record) => record.id) },
    },
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

    const records = await delegate.findMany({
      orderBy: { updatedAt: 'desc' },
    });

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
      data: {
        ...sanitizeRecordPayload(resource, req.body),
        createdBy: req.authUser?.username || req.authUser?.email || null,
      },
    });

    const attachments = sanitizeAttachments(
      req.body?.attachments,
      entityTypes[resource],
      record.id,
      req.authUser?.username || req.authUser?.email || null
    );

    if (attachments.length > 0) {
      await prisma.attachment.createMany({ data: attachments });
    }

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
        where: {
          entityType: entityTypes[resource],
          entityId: req.params.id,
        },
      });

      const attachments = sanitizeAttachments(
        req.body?.attachments,
        entityTypes[resource],
        req.params.id,
        req.authUser?.username || req.authUser?.email || null
      );

      if (attachments.length > 0) {
        await prisma.attachment.createMany({ data: attachments });
      }
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
      where: {
        entityType: entityTypes[req.params.resource],
        entityId: req.params.id,
      },
    });

    await delegate.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
