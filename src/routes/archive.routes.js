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


const sanitizeRecordPayload = (body = {}) => ({
  title: cleanString(body.title) || 'سجل أرشيفي',
  category: cleanString(body.category) || 'عام',
  documentNumber: cleanString(body.documentNumber),
  documentDate: cleanString(body.documentDate),
  documentDateType: body.documentDateType === 'hijri' ? 'hijri' : 'gregorian',
  issuingAuthority: cleanString(body.issuingAuthority),
  confidentiality: ['public', 'internal', 'confidential'].includes(body.confidentiality)
    ? body.confidentiality
    : 'internal',
  tags: cleanString(body.tags),
  description: cleanString(body.description),
});

const sanitizeAttachmentPayload = (body = {}) => ({
  fileName: cleanString(body.fileName) || cleanString(body.originalName) || 'file',
  originalName: cleanString(body.originalName),
  mimeType: cleanString(body.mimeType),
  fileSize:
    body.fileSize === '' || body.fileSize === undefined || body.fileSize === null
      ? 0
      : Number(body.fileSize) || 0,
  driveUrl: cleanString(body.driveUrl),
  driveFileId: cleanString(body.driveFileId),
  version: Math.max(1, Number.parseInt(String(body.version || '1'), 10) || 1),
  versionGroupId: cleanString(body.versionGroupId) || undefined,
  versionNote: cleanString(body.versionNote),
  isCurrent: body.isCurrent !== false,
  addedBy: cleanString(body.addedBy),
  legacyDocumentId: cleanString(body.legacyDocumentId),
});

const recordInclude = {
  attachments: {
    orderBy: [
      { isCurrent: 'desc' },
      { versionGroupId: 'asc' },
      { version: 'desc' },
      { createdAt: 'desc' },
    ],
  },
  activities: { orderBy: { createdAt: 'desc' }, take: 100 },
};

const serializeRecord = (record) => {
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];
  const currentAttachments = attachments.filter((item) => item.isCurrent);
  const effectiveCurrent = currentAttachments.length ? currentAttachments : attachments.slice(0, 1);
  const primary = effectiveCurrent[0] || attachments[0] || null;
  return {
    ...record,
    attachmentCount: effectiveCurrent.length,
    attachmentVersionCount: attachments.length,
    pendingVersionCount: attachments.filter((item) => item.versionStatus === 'draft').length,
    totalFileSize: effectiveCurrent.reduce((sum, item) => sum + Number(item.fileSize || 0), 0),
    fileName: primary?.fileName || '',
    originalName: primary?.originalName || '',
    mimeType: primary?.mimeType || '',
    fileSize: Number(primary?.fileSize || 0),
    driveUrl: primary?.driveUrl || '',
    driveFileId: primary?.driveFileId || '',
  };
};

const getArchiveApproverUsers = async (client = prisma, excludeUserId = null) => {
  const users = await client.appUser.findMany({
    where: {
      isActive: true,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      OR: [
        { role: 'admin' },
        {
          permissions: {
            some: {
              module: 'archive',
              canApproveArchive: true,
            },
          },
        },
      ],
    },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
    },
    orderBy: [{ role: 'asc' }, { username: 'asc' }],
  });

  return users.map((user) => ({
    id: user.id,
    name: user.username || user.email,
    email: user.email,
    role: user.role,
  }));
};

const nextArchiveNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `ARC-${year}-`;
  const latest = await prisma.archiveRecord.findFirst({
    where: { archiveNumber: { startsWith: prefix } },
    orderBy: { archiveNumber: 'desc' },
    select: { archiveNumber: true },
  });
  const last = Number.parseInt(String(latest?.archiveNumber || '').split('-').pop() || '0', 10) || 0;
  return `${prefix}${String(last + 1).padStart(6, '0')}`;
};

const ensureLegacyArchiveMigrated = async () => {
  const legacyDocuments = await prisma.archiveDocument.findMany({
    orderBy: { createdAt: 'asc' },
  });
  if (!legacyDocuments.length) return;

  const legacyIds = legacyDocuments.map((item) => item.id);
  const migrated = await prisma.archiveRecordAttachment.findMany({
    where: { legacyDocumentId: { in: legacyIds } },
    select: { legacyDocumentId: true },
  });
  const migratedIds = new Set(migrated.map((item) => item.legacyDocumentId).filter(Boolean));

  for (const legacy of legacyDocuments) {
    if (migratedIds.has(legacy.id) || !legacy.driveUrl) continue;

    const archiveNumber = await nextArchiveNumber();
    await prisma.archiveRecord.create({
      data: {
        archiveNumber,
        title: legacy.title || 'سجل أرشيفي',
        category: legacy.category || 'عام',
        documentNumber: legacy.documentNumber,
        documentDate: legacy.documentDate,
        documentDateType: legacy.documentDateType || 'gregorian',
        issuingAuthority: legacy.issuingAuthority,
        confidentiality: legacy.confidentiality || 'internal',
        tags: legacy.tags,
        description: legacy.description,
        createdBy: legacy.createdBy,
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt,
        attachments: {
          create: {
            fileName: legacy.fileName || legacy.originalName || 'file',
            originalName: legacy.originalName,
            mimeType: legacy.mimeType,
            fileSize: Number(legacy.fileSize || 0),
            driveUrl: legacy.driveUrl,
            driveFileId: legacy.driveFileId,
            addedBy: legacy.createdBy,
            legacyDocumentId: legacy.id,
            createdAt: legacy.createdAt,
            updatedAt: legacy.updatedAt,
          },
        },
        activities: {
          create: {
            action: 'legacy_migrated',
            description: 'نقل تلقائي من بنية الأرشفة السابقة إلى سجل أرشيفي متعدد الملفات',
            actorName: 'النظام',
            metadata: { legacyDocumentId: legacy.id },
            createdAt: legacy.createdAt,
          },
        },
      },
    });
  }
};

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


router.get('/records', async (_req, res, next) => {
  try {
    await ensureLegacyArchiveMigrated();
    const records = await prisma.archiveRecord.findMany({
      where: { deletedAt: null },
      include: recordInclude,
      orderBy: { updatedAt: 'desc' },
    });
    res.json(records.map(serializeRecord));
  } catch (error) {
    next(error);
  }
});

router.get('/records/trash', async (_req, res, next) => {
  try {
    const records = await prisma.archiveRecord.findMany({
      where: { deletedAt: { not: null } },
      include: recordInclude,
      orderBy: { deletedAt: 'desc' },
    });
    res.json(records.map(serializeRecord));
  } catch (error) {
    next(error);
  }
});

router.get('/records/version-approvers', async (req, res, next) => {
  try {
    const approvers = await getArchiveApproverUsers(prisma, req.authUser?.id || null);
    res.json(approvers);
  } catch (error) {
    next(error);
  }
});

router.get('/records/version-approvals', async (req, res, next) => {
  try {
    const requestedStatus = String(req.query.status || 'draft').trim();
    const allowedStatuses = new Set(['draft', 'approved', 'superseded', 'cancelled', 'all']);
    const status = allowedStatuses.has(requestedStatus) ? requestedStatus : 'draft';
    const search = String(req.query.search || '').trim();
    const confidentiality = String(req.query.confidentiality || '').trim();
    const addedBy = String(req.query.addedBy || '').trim();

    const conditions = [
      { record: { deletedAt: null } },
      ...(status !== 'all' ? [{ versionStatus: status }] : []),
      ...(addedBy ? [{ addedBy: { contains: addedBy, mode: 'insensitive' } }] : []),
      ...(confidentiality ? [{ record: { deletedAt: null, confidentiality } }] : []),
    ];

    if (req.authUser?.role !== 'admin') {
      conditions.push({
        OR: [
          { approvalRoute: 'pool' },
          { assignedApproverId: req.authUser?.id || '__none__' },
        ],
      });
    }

    if (search) {
      conditions.push({
        OR: [
          { originalName: { contains: search, mode: 'insensitive' } },
          { fileName: { contains: search, mode: 'insensitive' } },
          { addedBy: { contains: search, mode: 'insensitive' } },
          { assignedApproverName: { contains: search, mode: 'insensitive' } },
          {
            record: {
              OR: [
                { archiveNumber: { contains: search, mode: 'insensitive' } },
                { title: { contains: search, mode: 'insensitive' } },
                { category: { contains: search, mode: 'insensitive' } },
                { documentNumber: { contains: search, mode: 'insensitive' } },
                { issuingAuthority: { contains: search, mode: 'insensitive' } },
              ],
            },
          },
        ],
      });
    }

    const items = await prisma.archiveRecordAttachment.findMany({
      where: { AND: conditions },
      include: {
        record: {
          select: {
            id: true,
            archiveNumber: true,
            title: true,
            category: true,
            documentNumber: true,
            documentDate: true,
            issuingAuthority: true,
            confidentiality: true,
            updatedAt: true,
          },
        },
      },
      orderBy: [
        { approvalRequestedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 500,
    });

    res.json({
      items,
      total: items.length,
      status,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/records/:id', async (req, res, next) => {
  try {
    const record = await prisma.archiveRecord.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: recordInclude,
    });
    if (!record) return res.status(404).json({ message: 'السجل الأرشيفي غير موجود' });
    res.json(serializeRecord(record));
  } catch (error) {
    next(error);
  }
});

router.post('/records', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const data = sanitizeRecordPayload(req.body);
    const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
      .map(sanitizeAttachmentPayload);

    if (!attachments.length) {
      return res.status(400).json({ message: 'يجب إرفاق ملف واحد على الأقل عند إنشاء السجل الأرشيفي' });
    }
    if (attachments.some((item) => !item.driveUrl)) {
      return res.status(400).json({ message: 'رابط Google Drive مطلوب لكل ملف مرفق' });
    }

    const archiveNumber = await nextArchiveNumber();
    const record = await prisma.archiveRecord.create({
      data: {
        ...data,
        archiveNumber,
        createdById: changedBy.id,
        createdBy: changedBy.name,
        updatedBy: changedBy.name,
        attachments: {
          create: attachments.map((item) => ({
            ...item,
            addedById: changedBy.id,
            addedBy: changedBy.name,
          })),
        },
        activities: {
          create: {
            action: 'record_created',
            description: `إنشاء السجل الأرشيفي وإضافة ${attachments.length} ملف`,
            actorId: changedBy.id,
            actorName: changedBy.name,
            metadata: { attachmentCount: attachments.length },
          },
        },
      },
      include: recordInclude,
    });

    res.status(201).json(serializeRecord(record));
  } catch (error) {
    next(error);
  }
});

router.put('/records/:id', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const current = await prisma.archiveRecord.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!current) return res.status(404).json({ message: 'السجل الأرشيفي غير موجود' });

    const data = sanitizeRecordPayload(req.body);
    const record = await prisma.$transaction(async (tx) => {
      await tx.archiveRecord.update({
        where: { id: current.id },
        data: { ...data, updatedBy: changedBy.name },
      });
      await tx.archiveRecordActivity.create({
        data: {
          recordId: current.id,
          action: 'record_updated',
          description: 'تحديث البيانات الوصفية للسجل الأرشيفي',
          actorId: changedBy.id,
          actorName: changedBy.name,
        },
      });
      return tx.archiveRecord.findUnique({
        where: { id: current.id },
        include: recordInclude,
      });
    });

    res.json(serializeRecord(record));
  } catch (error) {
    next(error);
  }
});

router.post('/records/:id/attachments', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const current = await prisma.archiveRecord.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!current) return res.status(404).json({ message: 'السجل الأرشيفي غير موجود' });

    const source = Array.isArray(req.body?.attachments)
      ? req.body.attachments
      : req.body
        ? [req.body]
        : [];
    const attachments = source.map(sanitizeAttachmentPayload);
    if (!attachments.length || attachments.some((item) => !item.driveUrl)) {
      return res.status(400).json({ message: 'بيانات الملفات المرفقة غير مكتملة' });
    }

    const record = await prisma.$transaction(async (tx) => {
      for (const item of attachments) {
        await tx.archiveRecordAttachment.create({
          data: {
            ...item,
            recordId: current.id,
            addedById: changedBy.id,
            addedBy: changedBy.name,
          },
        });
      }
      await tx.archiveRecord.update({
        where: { id: current.id },
        data: { updatedBy: changedBy.name },
      });
      await tx.archiveRecordActivity.create({
        data: {
          recordId: current.id,
          action: 'attachments_added',
          description: `إضافة ${attachments.length} ملف إلى السجل الأرشيفي`,
          actorId: changedBy.id,
          actorName: changedBy.name,
          metadata: {
            attachmentCount: attachments.length,
            fileNames: attachments.map((item) => item.originalName || item.fileName),
          },
        },
      });
      return tx.archiveRecord.findUnique({
        where: { id: current.id },
        include: recordInclude,
      });
    });

    res.status(201).json(serializeRecord(record));
  } catch (error) {
    next(error);
  }
});

router.post('/records/:recordId/attachments/:attachmentId/versions', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const record = await prisma.archiveRecord.findFirst({
      where: { id: req.params.recordId, deletedAt: null },
    });
    if (!record) {
      return res.status(404).json({ message: 'السجل الأرشيفي غير موجود' });
    }

    const currentAttachment = await prisma.archiveRecordAttachment.findFirst({
      where: {
        id: req.params.attachmentId,
        recordId: req.params.recordId,
      },
    });
    if (!currentAttachment) {
      return res.status(404).json({ message: 'الملف المرفق غير موجود' });
    }

    const incoming = sanitizeAttachmentPayload(req.body || {});
    if (!incoming.driveUrl) {
      return res.status(400).json({ message: 'بيانات الإصدار الجديد غير مكتملة' });
    }

    const versionGroupId = currentAttachment.versionGroupId || currentAttachment.id;
    const latest = await prisma.archiveRecordAttachment.findFirst({
      where: {
        recordId: req.params.recordId,
        OR: [
          { versionGroupId },
          { id: currentAttachment.id },
        ],
      },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });

    const existingDraft = await prisma.archiveRecordAttachment.findFirst({
      where: {
        recordId: req.params.recordId,
        versionStatus: 'draft',
        OR: [
          { versionGroupId },
          { id: currentAttachment.id },
        ],
      },
    });
    if (existingDraft) {
      return res.status(409).json({
        message: 'يوجد إصدار مسودة بانتظار الاعتماد لهذا الملف. اعتمده أو ألغِه قبل إنشاء إصدار جديد.',
      });
    }

    const nextVersion = Math.max(1, Number(latest?.version || currentAttachment.version || 1) + 1);
    const approvalRoute = req.body?.approvalRoute === 'specific' ? 'specific' : 'pool';
    const eligibleApprovers = await getArchiveApproverUsers(prisma, changedBy.id);

    if (!eligibleApprovers.length) {
      return res.status(409).json({
        message: 'لا يوجد مستخدم آخر مخول باعتماد الأرشيف حاليًا. أضف معتمدًا آخر قبل إنشاء مسودة الإصدار.',
      });
    }

    let assignedApprover = null;
    if (approvalRoute === 'specific') {
      const approverUserId = String(req.body?.approverUserId || '').trim();
      assignedApprover = eligibleApprovers.find((item) => item.id === approverUserId) || null;

      if (!assignedApprover) {
        return res.status(400).json({
          message: 'اختر معتمدًا محددًا صالحًا ومخولًا باعتماد الأرشيف.',
        });
      }
    }

    const approvalRequestedAt = new Date();
    const approvalLabel =
      approvalRoute === 'specific'
        ? assignedApprover.name
        : 'مجموعة معتمدي الأرشيف';

    const updatedRecord = await prisma.$transaction(async (tx) => {
      if (!currentAttachment.versionGroupId) {
        await tx.archiveRecordAttachment.update({
          where: { id: currentAttachment.id },
          data: { versionGroupId },
        });
      }

      const draft = await tx.archiveRecordAttachment.create({
        data: {
          recordId: req.params.recordId,
          fileName: incoming.fileName,
          originalName: incoming.originalName,
          mimeType: incoming.mimeType,
          fileSize: incoming.fileSize,
          driveUrl: incoming.driveUrl,
          driveFileId: incoming.driveFileId,
          version: nextVersion,
          versionGroupId,
          versionNote: incoming.versionNote,
          versionStatus: 'draft',
          approvalRoute,
          assignedApproverId: assignedApprover?.id || null,
          assignedApproverName: assignedApprover?.name || null,
          approvalRequestedAt,
          isCurrent: false,
          addedById: changedBy.id,
          addedBy: changedBy.name,
        },
      });

      const recipients =
        approvalRoute === 'specific'
          ? [assignedApprover]
          : eligibleApprovers;

      if (recipients.length) {
        await tx.archiveApprovalNotification.createMany({
          data: recipients.map((recipient) => ({
            recipientUserId: recipient.id,
            recordId: req.params.recordId,
            attachmentId: draft.id,
            type: 'approval_requested',
            title: `طلب اعتماد إصدار V${nextVersion}`,
            message: `${record.archiveNumber} — ${record.title} — ${incoming.originalName || incoming.fileName}`,
          })),
        });
      }

      await tx.archiveRecord.update({
        where: { id: req.params.recordId },
        data: { updatedBy: changedBy.name },
      });

      await tx.archiveRecordActivity.create({
        data: {
          recordId: req.params.recordId,
          action: 'attachment_version_added',
          description: `إنشاء مسودة الإصدار ${nextVersion} للملف ${currentAttachment.originalName || currentAttachment.fileName} وإرسالها للاعتماد إلى ${approvalLabel}`,
          actorId: changedBy.id,
          actorName: changedBy.name,
          metadata: {
            attachmentId: draft.id,
            versionGroupId,
            previousVersion: currentAttachment.version,
            newVersion: nextVersion,
            versionNote: incoming.versionNote || null,
            fileName: incoming.originalName || incoming.fileName,
            status: 'draft',
            approvalRoute,
            assignedApproverId: assignedApprover?.id || null,
            assignedApproverName: assignedApprover?.name || null,
            approvalRequestedAt: approvalRequestedAt.toISOString(),
          },
        },
      });

      return tx.archiveRecord.findUnique({
        where: { id: req.params.recordId },
        include: recordInclude,
      });
    });

    res.status(201).json(serializeRecord(updatedRecord));
  } catch (error) {
    next(error);
  }
});

router.patch('/records/:recordId/attachments/:attachmentId/approve', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const approvalNote = cleanString(req.body?.note);

    const record = await prisma.archiveRecord.findFirst({
      where: { id: req.params.recordId, deletedAt: null },
    });
    if (!record) return res.status(404).json({ message: 'السجل الأرشيفي غير موجود' });

    const draft = await prisma.archiveRecordAttachment.findFirst({
      where: {
        id: req.params.attachmentId,
        recordId: req.params.recordId,
      },
    });
    if (!draft) return res.status(404).json({ message: 'إصدار الملف غير موجود' });
    if (draft.versionStatus !== 'draft') {
      return res.status(409).json({ message: 'يمكن اعتماد الإصدارات الموجودة بحالة مسودة فقط' });
    }

    const actorName = String(changedBy.name || '').trim().toLowerCase();
    const uploaderName = String(draft.addedBy || '').trim().toLowerCase();
    const uploadedBySameUser =
      Boolean(changedBy.id && draft.addedById && changedBy.id === draft.addedById) ||
      Boolean(!draft.addedById && actorName && uploaderName && actorName === uploaderName);

    if (uploadedBySameUser) {
      return res.status(403).json({
        message: 'لا يمكن اعتماد إصدار قمت برفعه بنفسك. يجب أن يعتمد الإصدار مستخدم آخر لديه صلاحية «اعتماد الأرشيف».',
        code: 'ARCHIVE_MAKER_CHECKER_SELF_APPROVAL_BLOCKED',
      });
    }

    const versionGroupId = draft.versionGroupId || draft.id;
    const approvedAt = new Date();

    const updatedRecord = await prisma.$transaction(async (tx) => {
      await tx.archiveRecordAttachment.updateMany({
        where: {
          recordId: req.params.recordId,
          versionGroupId,
          isCurrent: true,
        },
        data: {
          isCurrent: false,
          versionStatus: 'superseded',
        },
      });

      await tx.archiveRecordAttachment.update({
        where: { id: draft.id },
        data: {
          versionGroupId,
          versionStatus: 'approved',
          isCurrent: true,
          approvedById: changedBy.id,
          approvedByName: changedBy.name,
          approvedAt,
          approvalNote,
          cancelledById: null,
          cancelledByName: null,
          cancelledAt: null,
          cancelReason: null,
        },
      });

      await tx.archiveRecord.update({
        where: { id: req.params.recordId },
        data: { updatedBy: changedBy.name },
      });

      await tx.archiveRecordActivity.create({
        data: {
          recordId: req.params.recordId,
          action: 'attachment_version_approved',
          description: `اعتماد الإصدار ${draft.version} للملف ${draft.originalName || draft.fileName} كنسخة رسمية حالية`,
          actorId: changedBy.id,
          actorName: changedBy.name,
          metadata: {
            attachmentId: draft.id,
            versionGroupId,
            version: draft.version,
            approvalNote,
            makerUserId: draft.addedById || null,
            makerName: draft.addedBy || null,
            checkerUserId: changedBy.id,
            checkerName: changedBy.name,
          },
        },
      });

      return tx.archiveRecord.findUnique({
        where: { id: req.params.recordId },
        include: recordInclude,
      });
    });

    res.json(serializeRecord(updatedRecord));
  } catch (error) {
    next(error);
  }
});

router.patch('/records/:recordId/attachments/:attachmentId/cancel', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const cancelReason = cleanString(req.body?.reason);

    const record = await prisma.archiveRecord.findFirst({
      where: { id: req.params.recordId, deletedAt: null },
    });
    if (!record) return res.status(404).json({ message: 'السجل الأرشيفي غير موجود' });

    const draft = await prisma.archiveRecordAttachment.findFirst({
      where: {
        id: req.params.attachmentId,
        recordId: req.params.recordId,
      },
    });
    if (!draft) return res.status(404).json({ message: 'إصدار الملف غير موجود' });
    if (draft.versionStatus !== 'draft') {
      return res.status(409).json({ message: 'يمكن إلغاء الإصدارات الموجودة بحالة مسودة فقط' });
    }

    const cancelledAt = new Date();
    const updatedRecord = await prisma.$transaction(async (tx) => {
      await tx.archiveRecordAttachment.update({
        where: { id: draft.id },
        data: {
          versionStatus: 'cancelled',
          isCurrent: false,
          cancelledById: changedBy.id,
          cancelledByName: changedBy.name,
          cancelledAt,
          cancelReason,
        },
      });

      await tx.archiveRecord.update({
        where: { id: req.params.recordId },
        data: { updatedBy: changedBy.name },
      });

      await tx.archiveRecordActivity.create({
        data: {
          recordId: req.params.recordId,
          action: 'attachment_version_cancelled',
          description: `إلغاء مسودة الإصدار ${draft.version} للملف ${draft.originalName || draft.fileName}`,
          actorId: changedBy.id,
          actorName: changedBy.name,
          metadata: {
            attachmentId: draft.id,
            versionGroupId: draft.versionGroupId,
            version: draft.version,
            cancelReason,
          },
        },
      });

      return tx.archiveRecord.findUnique({
        where: { id: req.params.recordId },
        include: recordInclude,
      });
    });

    res.json(serializeRecord(updatedRecord));
  } catch (error) {
    next(error);
  }
});

router.post('/records/merge', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const recordIds = Array.from(
      new Set(
        (Array.isArray(req.body?.recordIds) ? req.body.recordIds : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );
    const targetId = String(req.body?.targetId || '').trim();

    if (recordIds.length < 2) {
      return res.status(400).json({ message: 'حدد سجلين أرشيفيين على الأقل للدمج' });
    }
    if (!targetId || !recordIds.includes(targetId)) {
      return res.status(400).json({ message: 'اختر السجل الرئيسي من بين السجلات المحددة' });
    }

    const records = await prisma.archiveRecord.findMany({
      where: {
        id: { in: recordIds },
        deletedAt: null,
      },
      include: {
        attachments: true,
      },
    });

    if (records.length !== recordIds.length) {
      return res.status(409).json({
        message: 'تعذر الدمج لأن أحد السجلات المحددة غير موجود أو لم يعد متاحًا',
      });
    }

    const target = records.find((item) => item.id === targetId);
    if (!target) {
      return res.status(404).json({ message: 'السجل الرئيسي غير موجود' });
    }

    const sources = records.filter((item) => item.id !== targetId);
    const movedAttachmentCount = sources.reduce(
      (sum, item) => sum + item.attachments.length,
      0,
    );
    const mergedAt = new Date();

    const mergedRecord = await prisma.$transaction(async (tx) => {
      if (sources.length) {
        await tx.archiveRecordAttachment.updateMany({
          where: { recordId: { in: sources.map((item) => item.id) } },
          data: { recordId: targetId },
        });
      }

      await tx.archiveRecord.update({
        where: { id: targetId },
        data: {
          updatedBy: changedBy.name,
          status: 'active',
        },
      });

      await tx.archiveRecordActivity.create({
        data: {
          recordId: targetId,
          action: 'records_merged',
          description: `دمج ${sources.length} سجل أرشيفي داخل السجل الرئيسي ونقل ${movedAttachmentCount} ملف`,
          actorId: changedBy.id,
          actorName: changedBy.name,
          metadata: {
            sourceRecords: sources.map((item) => ({
              id: item.id,
              archiveNumber: item.archiveNumber,
              title: item.title,
            })),
            movedAttachmentCount,
          },
        },
      });

      for (const source of sources) {
        await tx.archiveRecord.update({
          where: { id: source.id },
          data: {
            deletedAt: mergedAt,
            mergedAt,
            mergedIntoId: targetId,
            status: 'merged',
            updatedBy: changedBy.name,
          },
        });
        await tx.archiveRecordActivity.create({
          data: {
            recordId: source.id,
            action: 'record_merged',
            description: `تم دمج السجل داخل ${target.archiveNumber} — ${target.title}`,
            actorId: changedBy.id,
            actorName: changedBy.name,
            metadata: {
              targetId,
              targetArchiveNumber: target.archiveNumber,
            },
          },
        });
      }

      return tx.archiveRecord.findUnique({
        where: { id: targetId },
        include: recordInclude,
      });
    });

    res.json({
      record: serializeRecord(mergedRecord),
      mergedSourceIds: sources.map((item) => item.id),
      movedAttachmentCount,
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/records/:recordId/attachments/:attachmentId', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const attachment = await prisma.archiveRecordAttachment.findFirst({
      where: {
        id: req.params.attachmentId,
        recordId: req.params.recordId,
      },
    });
    if (!attachment) return res.status(404).json({ message: 'الملف المرفق غير موجود' });

    const count = await prisma.archiveRecordAttachment.count({
      where: { recordId: req.params.recordId },
    });
    if (count <= 1) {
      return res.status(409).json({
        message: 'لا يمكن حذف آخر ملف من السجل. احذف السجل الأرشيفي كاملًا إذا لم تعد بحاجة إليه.',
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.archiveRecordAttachment.delete({ where: { id: attachment.id } });
      await tx.archiveRecord.update({
        where: { id: req.params.recordId },
        data: { updatedBy: changedBy.name },
      });
      await tx.archiveRecordActivity.create({
        data: {
          recordId: req.params.recordId,
          action: 'attachment_removed',
          description: `إزالة الملف ${attachment.originalName || attachment.fileName} من السجل`,
          actorId: changedBy.id,
          actorName: changedBy.name,
          metadata: {
            attachmentId: attachment.id,
            driveFileId: attachment.driveFileId,
          },
        },
      });
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.delete('/records/:id', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const current = await prisma.archiveRecord.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!current) return res.status(404).json({ message: 'السجل الأرشيفي غير موجود' });

    await prisma.$transaction(async (tx) => {
      await tx.archiveRecord.update({
        where: { id: current.id },
        data: {
          deletedAt: new Date(),
          status: 'deleted',
          updatedBy: changedBy.name,
        },
      });
      await tx.archiveRecordActivity.create({
        data: {
          recordId: current.id,
          action: 'record_deleted',
          description: 'نقل السجل الأرشيفي إلى المحذوفات',
          actorId: changedBy.id,
          actorName: changedBy.name,
        },
      });
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.patch('/records/:id/restore', async (req, res, next) => {
  try {
    const changedBy = actor(req);
    const current = await prisma.archiveRecord.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'السجل الأرشيفي غير موجود' });
    if (!current.deletedAt) return res.status(409).json({ message: 'السجل غير موجود في المحذوفات' });
    if (current.status === 'merged' && current.mergedIntoId) {
      return res.status(409).json({
        message: 'هذا السجل تم دمجه في سجل آخر ولا يمكن استعادته كسجل مستقل من المحذوفات.',
      });
    }

    const record = await prisma.$transaction(async (tx) => {
      await tx.archiveRecord.update({
        where: { id: current.id },
        data: {
          deletedAt: null,
          status: 'active',
          updatedBy: changedBy.name,
        },
      });
      await tx.archiveRecordActivity.create({
        data: {
          recordId: current.id,
          action: 'record_restored',
          description: 'استعادة السجل الأرشيفي من المحذوفات',
          actorId: changedBy.id,
          actorName: changedBy.name,
        },
      });
      return tx.archiveRecord.findUnique({
        where: { id: current.id },
        include: recordInclude,
      });
    });

    res.json(serializeRecord(record));
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
