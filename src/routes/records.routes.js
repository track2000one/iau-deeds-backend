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

const dateFields = new Set(['deliveryDate', 'contractStartDate']);
const numberFields = new Set(['area', 'rentAmount']);

const sanitizeRecordPayload = (body = {}) => {
  const data = { ...body };
  delete data.id;
  delete data.createdAt;
  delete data.updatedAt;
  delete data.attachments;

  for (const field of dateFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      data[field] = data[field] ? new Date(data[field]) : null;
    }
  }

  for (const field of numberFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      data[field] =
        data[field] === '' || data[field] == null
          ? null
          : Number(data[field]);
    }
  }

  return data;
};

const sanitizeAttachments = (attachments, entityType, entityId) => {
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
      createdBy: attachment.createdBy || null,
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

  const byEntity = new Map();
  for (const attachment of attachments) {
    const current = byEntity.get(attachment.entityId) || [];
    current.push(attachment);
    byEntity.set(attachment.entityId, current);
  }

  return records.map((record) => ({
    ...record,
    attachments: byEntity.get(record.id) || [],
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

    const entityType = entityTypes[req.params.resource];
    const recordData = sanitizeRecordPayload(req.body);
    const incomingAttachments = Array.isArray(req.body?.attachments)
      ? req.body.attachments
      : [];

    const record = await delegate.create({ data: recordData });

    const attachmentData = sanitizeAttachments(
      incomingAttachments,
      entityType,
      record.id
    );

    if (attachmentData.length > 0) {
      await prisma.attachment.createMany({ data: attachmentData });
    }

    const [result] = await attachFilesToRecords(req.params.resource, [record]);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.put('/:resource/:id', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;

    const entityType = entityTypes[req.params.resource];
    const recordData = sanitizeRecordPayload(req.body);
    const hasAttachments = Object.prototype.hasOwnProperty.call(
      req.body || {},
      'attachments'
    );
    const incomingAttachments = Array.isArray(req.body?.attachments)
      ? req.body.attachments
      : [];

    const record = await delegate.update({
      where: { id: req.params.id },
      data: recordData,
    });

    if (hasAttachments) {
      await prisma.attachment.deleteMany({
        where: {
          entityType,
          entityId: req.params.id,
        },
      });

      const attachmentData = sanitizeAttachments(
        incomingAttachments,
        entityType,
        req.params.id
      );

      if (attachmentData.length > 0) {
        await prisma.attachment.createMany({ data: attachmentData });
      }
    }

    const [result] = await attachFilesToRecords(req.params.resource, [record]);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/:resource/:id', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;

    const entityType = entityTypes[req.params.resource];

    await prisma.attachment.deleteMany({
      where: {
        entityType,
        entityId: req.params.id,
      },
    });

    await delegate.delete({
      where: { id: req.params.id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
