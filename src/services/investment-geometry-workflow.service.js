import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from './audit.service.js';

const ENTITY_CONFIG = {
  investment_site: {
    model: 'investmentSite',
    attachmentType: 'investment_site',
    label: (entity) => entity?.name || entity?.code || null,
  },
  investment_area: {
    model: 'investmentArea',
    attachmentType: 'investment_area',
    label: (entity) => entity?.areaCode || entity?.name || null,
  },
};

const workflowActionLabels = {
  REVIEW: 'geometry_review',
  APPROVE: 'geometry_approve',
  REQUEST_CHANGE: 'geometry_change_request',
};

const statusByAction = {
  REVIEW: 'REVIEWED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGE: 'CHANGE_REQUESTED',
};

const assertAdmin = (req) => {
  if (req.authUser?.role !== 'admin') {
    const error = new Error('اعتماد الحدود أو طلب تعديل حدود معتمدة متاح للمسؤول فقط');
    error.statusCode = 403;
    throw error;
  }
};

const assertPolygon = (entity) => {
  const value = entity?.geoJson;
  if (!value || typeof value !== 'object') {
    const error = new Error('لا يمكن تنفيذ الإجراء قبل حفظ حدود Polygon صالحة');
    error.statusCode = 400;
    throw error;
  }

  const geometry =
    value.type === 'Feature' && value.geometry
      ? value.geometry
      : value;

  const ring = geometry?.type === 'Polygon'
    ? geometry?.coordinates?.[0]
    : null;

  if (!Array.isArray(ring) || ring.length < 4) {
    const error = new Error('حدود Polygon غير مكتملة أو غير صالحة');
    error.statusCode = 400;
    throw error;
  }
};

const verifyReferenceAttachment = async ({
  attachmentId,
  entityType,
  entityId,
}) => {
  if (!attachmentId) {
    const error = new Error('يجب اختيار المرفق المرجعي قبل اعتماد مراجعة الحدود');
    error.statusCode = 400;
    throw error;
  }

  const attachment = await prisma.attachment.findFirst({
    where: {
      id: attachmentId,
      entityType,
      entityId,
    },
    select: {
      id: true,
      title: true,
      attachmentType: true,
      driveUrl: true,
    },
  });

  if (!attachment) {
    const error = new Error('المرفق المرجعي غير موجود أو لا يتبع السجل الحالي');
    error.statusCode = 400;
    throw error;
  }

  return attachment;
};

export const geometryWorkflowResetData = () => ({
  geometryApprovalStatus: 'DRAFT',
  geometryReviewedById: null,
  geometryReviewedByName: null,
  geometryReviewedAt: null,
  geometryApprovedById: null,
  geometryApprovedByName: null,
  geometryApprovedAt: null,
  geometryReferenceAttachmentId: null,
  geometryWorkflowNote: null,
});

export const geometryFieldsChanged = (existing, input) => {
  const has = (key) => Object.prototype.hasOwnProperty.call(input || {}, key);

  if (
    has('geoJson') &&
    JSON.stringify(existing?.geoJson ?? null) !==
      JSON.stringify(input?.geoJson ?? null)
  ) {
    return true;
  }

  for (const key of ['latitude', 'longitude']) {
    if (!has(key)) continue;

    const before =
      existing?.[key] == null || existing?.[key] === ''
        ? null
        : Number(existing[key]);
    const after =
      input?.[key] == null || input?.[key] === ''
        ? null
        : Number(input[key]);

    if (before !== after) return true;
  }

  if (
    has('geometryAccuracy') &&
    input.geometryAccuracy !== existing?.geometryAccuracy
  ) {
    return true;
  }

  return false;
};

export const enforceGeometryLock = (existing, input) => {
  const changed = geometryFieldsChanged(existing, input);

  if (
    changed &&
    existing?.geometryApprovalStatus === 'APPROVED'
  ) {
    const error = new Error(
      'الحدود الجغرافية معتمدة ومقفلة. استخدم إجراء «طلب تعديل حدود» قبل تغيير Polygon أو الإحداثيات أو مستوى الدقة.'
    );
    error.statusCode = 409;
    throw error;
  }

  return changed;
};

export const runGeometryWorkflow = async ({
  req,
  entityType,
  entityId,
  action,
  note = null,
  referenceAttachmentId = null,
}) => {
  const config = ENTITY_CONFIG[entityType];

  if (!config) {
    const error = new Error('نوع سجل الحدود غير مدعوم');
    error.statusCode = 400;
    throw error;
  }

  const model = prisma[config.model];
  const existing = await model.findUnique({
    where: { id: entityId },
  });

  if (!existing || existing.isActive === false) {
    const error = new Error('السجل غير موجود أو مؤرشف');
    error.statusCode = 404;
    throw error;
  }

  assertPolygon(existing);

  const normalizedNote = String(note || '').trim() || null;
  let attachment = null;
  let updateData = {};

  if (action === 'REVIEW') {
    if (existing.geometryApprovalStatus !== 'DRAFT') {
      const error = new Error('يمكن تسجيل المراجعة للحدود الموجودة في حالة «مسودة» فقط');
      error.statusCode = 409;
      throw error;
    }

    attachment = await verifyReferenceAttachment({
      attachmentId: referenceAttachmentId,
      entityType: config.attachmentType,
      entityId,
    });

    updateData = {
      geometryApprovalStatus: 'REVIEWED',
      geometryReviewedById: req.authUser?.id || null,
      geometryReviewedByName:
        req.authUser?.username || req.authUser?.email || null,
      geometryReviewedAt: new Date(),
      geometryApprovedById: null,
      geometryApprovedByName: null,
      geometryApprovedAt: null,
      geometryReferenceAttachmentId: attachment.id,
      geometryWorkflowNote: normalizedNote,
    };
  } else if (action === 'APPROVE') {
    assertAdmin(req);

    if (existing.geometryApprovalStatus !== 'REVIEWED') {
      const error = new Error('لا يمكن اعتماد الحدود قبل اكتمال مرحلة المراجعة');
      error.statusCode = 409;
      throw error;
    }

    attachment = await verifyReferenceAttachment({
      attachmentId:
        referenceAttachmentId ||
        existing.geometryReferenceAttachmentId,
      entityType: config.attachmentType,
      entityId,
    });

    updateData = {
      geometryApprovalStatus: 'APPROVED',
      geometryApprovedById: req.authUser?.id || null,
      geometryApprovedByName:
        req.authUser?.username || req.authUser?.email || null,
      geometryApprovedAt: new Date(),
      geometryReferenceAttachmentId: attachment.id,
      geometryWorkflowNote: normalizedNote || existing.geometryWorkflowNote,
    };
  } else if (action === 'REQUEST_CHANGE') {
    assertAdmin(req);

    if (existing.geometryApprovalStatus !== 'APPROVED') {
      const error = new Error('طلب تعديل الحدود متاح للحدود المعتمدة فقط');
      error.statusCode = 409;
      throw error;
    }

    if (!normalizedNote) {
      const error = new Error('سبب طلب تعديل الحدود مطلوب');
      error.statusCode = 400;
      throw error;
    }

    updateData = {
      geometryApprovalStatus: 'CHANGE_REQUESTED',
      geometryWorkflowNote: normalizedNote,
    };
  } else {
    const error = new Error('إجراء دورة الاعتماد غير معروف');
    error.statusCode = 400;
    throw error;
  }

  const updated = await model.update({
    where: { id: entityId },
    data: updateData,
  });

  await createAuditLog({
    user: req.authUser,
    action: workflowActionLabels[action],
    module: 'investments',
    entity: entityType,
    entityId,
    entityLabel: config.label(existing),
    status: 'success',
    description:
      action === 'REVIEW'
        ? 'تمت مراجعة الحدود الجغرافية'
        : action === 'APPROVE'
          ? 'تم اعتماد الحدود الجغرافية وقفلها'
          : 'تم تسجيل طلب تعديل للحدود الجغرافية المعتمدة',
    previousData: {
      geometryApprovalStatus: existing.geometryApprovalStatus,
      geometryReferenceAttachmentId:
        existing.geometryReferenceAttachmentId,
      geometryWorkflowNote: existing.geometryWorkflowNote,
    },
    newData: {
      geometryApprovalStatus: updated.geometryApprovalStatus,
      geometryReferenceAttachmentId:
        updated.geometryReferenceAttachmentId,
      geometryWorkflowNote: updated.geometryWorkflowNote,
      geometryReviewedByName: updated.geometryReviewedByName,
      geometryReviewedAt: updated.geometryReviewedAt,
      geometryApprovedByName: updated.geometryApprovedByName,
      geometryApprovedAt: updated.geometryApprovedAt,
    },
    metadata: {
      workflowAction: action,
      referenceAttachment: attachment,
    },
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'],
  });

  return updated;
};
