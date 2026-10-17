import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

const actor = (req) => ({
  id: req.authUser?.id || null,
  name: req.authUser?.username || req.authUser?.email || 'مستخدم',
});

const cleanString = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const sanitizePayload = (body = {}) => ({
  title: cleanString(body.title) || 'ملف مؤرشف',
  category: cleanString(body.category) || 'عام',
  documentNumber: cleanString(body.documentNumber),
  documentDate: cleanString(body.documentDate),
  documentDateType:
    body.documentDateType === 'hijri' ? 'hijri' : 'gregorian',
  issuingAuthority: cleanString(body.issuingAuthority),
  confidentiality: ['public', 'internal', 'confidential'].includes(
    body.confidentiality
  )
    ? body.confidentiality
    : 'internal',
  tags: cleanString(body.tags),
  description: cleanString(body.description),
  fileName: cleanString(body.fileName) || cleanString(body.originalName) || 'file',
  originalName: cleanString(body.originalName),
  mimeType: cleanString(body.mimeType),
  fileSize:
    body.fileSize === '' || body.fileSize === undefined || body.fileSize === null
      ? 0
      : Number(body.fileSize) || 0,
  driveUrl: cleanString(body.driveUrl),
  driveFileId: cleanString(body.driveFileId),
  createdBy: cleanString(body.createdBy),
});

router.get('/', async (_req, res, next) => {
  try {
    const documents = await prisma.archiveDocument.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    res.json(documents);
  } catch (error) {
    next(error);
  }
});

router.get('/transactions', async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(500, Math.max(10, Number.parseInt(String(req.query.pageSize || '100'), 10) || 100));
    const search = String(req.query.search || '').trim();

    const where = {
      archivedAt: { not: null },
      ...(search
        ? {
            OR: [
              { trackingNumber: { contains: search, mode: 'insensitive' } },
              { transactionNumber: { contains: search, mode: 'insensitive' } },
              { subject: { contains: search, mode: 'insensitive' } },
              { sourceEntity: { contains: search, mode: 'insensitive' } },
              { currentAssigneeName: { contains: search, mode: 'insensitive' } },
              { archivedByName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      prisma.transactionFollowUp.count({ where }),
      prisma.transactionFollowUp.findMany({
        where,
        orderBy: [{ archivedAt: 'desc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      items,
      total,
      page,
      pageSize,
      totalPages: total ? Math.ceil(total / pageSize) : 0,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/transactions/:id', async (req, res, next) => {
  try {
    const transaction = await prisma.transactionFollowUp.findFirst({
      where: { id: req.params.id, archivedAt: { not: null } },
      include: {
        events: { orderBy: { createdAt: 'desc' } },
        directives: {
          include: { reviews: { orderBy: { reviewedAt: 'desc' } } },
          orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        },
        extensionRequests: { orderBy: { createdAt: 'desc' } },
        externalWaits: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!transaction) {
      return res.status(404).json({ message: 'المعاملة المؤرشفة غير موجودة' });
    }

    const attachments = await prisma.attachment.findMany({
      where: {
        entityType: 'transaction_follow_up',
        entityId: transaction.id,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ ...transaction, attachments });
  } catch (error) {
    next(error);
  }
});

router.post('/transactions/:id', async (req, res, next) => {
  try {
    const current = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
    });

    if (!current) {
      return res.status(404).json({ message: 'المعاملة غير موجودة' });
    }
    if (current.archivedAt) {
      return res.status(409).json({ message: 'المعاملة مؤرشفة مسبقًا' });
    }
    if (current.status !== 'closed') {
      return res.status(409).json({
        message: 'لا يمكن ترحيل المعاملة إلى الأرشفة إلا بعد اعتماد إنجازها وإقفالها.',
      });
    }

    const changedBy = actor(req);
    const note = cleanString(req.body?.note);
    const archivedAt = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUp.update({
        where: { id: current.id },
        data: {
          archivedAt,
          archivedById: changedBy.id,
          archivedByName: changedBy.name,
          archiveNote: note,
        },
      });

      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: current.id,
          eventType: 'archived',
          fromStatus: current.status,
          toStatus: current.status,
          fromAssigneeUserId: current.currentAssigneeUserId,
          fromAssigneeName: current.currentAssigneeName,
          toAssigneeUserId: current.currentAssigneeUserId,
          toAssigneeName: current.currentAssigneeName,
          actionText: 'ترحيل المعاملة إلى الأرشفة',
          note,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });

      return row;
    });

    res.status(201).json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/transactions/:id', async (req, res, next) => {
  try {
    const current = await prisma.transactionFollowUp.findFirst({
      where: { id: req.params.id, archivedAt: { not: null } },
      select: {
        id: true,
        transactionNumber: true,
      },
    });

    if (!current) {
      return res.status(404).json({ message: 'المعاملة المؤرشفة غير موجودة' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({
        where: {
          entityType: 'transaction_follow_up',
          entityId: current.id,
        },
      });

      await tx.transactionFollowUp.delete({
        where: { id: current.id },
      });
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.patch('/transactions/:id/restore', async (req, res, next) => {
  try {
    const current = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
    });

    if (!current) {
      return res.status(404).json({ message: 'المعاملة غير موجودة' });
    }
    if (!current.archivedAt) {
      return res.status(409).json({ message: 'المعاملة غير موجودة في الأرشفة' });
    }

    const changedBy = actor(req);
    const note = cleanString(req.body?.note);

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUp.update({
        where: { id: current.id },
        data: {
          archivedAt: null,
          archivedById: null,
          archivedByName: null,
          archiveNote: null,
        },
      });

      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: current.id,
          eventType: 'archive_restored',
          fromStatus: current.status,
          toStatus: current.status,
          fromAssigneeUserId: current.currentAssigneeUserId,
          fromAssigneeName: current.currentAssigneeName,
          toAssigneeUserId: current.currentAssigneeUserId,
          toAssigneeName: current.currentAssigneeName,
          actionText: 'استعادة المعاملة من الأرشفة',
          note,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });

      return row;
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const document = await prisma.archiveDocument.findUnique({
      where: { id: req.params.id },
    });

    if (!document) {
      return res.status(404).json({ message: 'ملف الأرشفة غير موجود' });
    }

    res.json(document);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const data = sanitizePayload(req.body);

    if (!data.driveUrl) {
      return res.status(400).json({ message: 'رابط Google Drive مطلوب' });
    }

    const document = await prisma.archiveDocument.create({ data });
    res.status(201).json(document);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const data = sanitizePayload(req.body);

    if (!data.driveUrl) {
      return res.status(400).json({ message: 'رابط Google Drive مطلوب' });
    }

    const document = await prisma.archiveDocument.update({
      where: { id: req.params.id },
      data,
    });

    res.json(document);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.archiveDocument.delete({
      where: { id: req.params.id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
