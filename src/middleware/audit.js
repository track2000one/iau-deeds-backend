import { prisma } from '../prisma.js';
import {
  createAuditLog,
  getClientIp,
  sanitizeAuditData,
} from '../services/audit.service.js';

const actionByMethod = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

const moduleLabels = {
  deeds: 'الصكوك',
  attachments: 'المرفقات',
  uploads: 'رفع الملفات',
  records: 'السجلات',
  archive: 'الأرشفة',
  users: 'المستخدمون',
};

const prismaModelByModule = {
  deeds: 'deed',
  attachments: 'attachment',
  archive: 'archiveDocument',
  users: 'appUser',
};

const recordsModelByResource = {
  'allocated-lands': 'allocatedLand',
  'delivered-lands': 'deliveredLand',
  'leased-lands-out': 'leasedLandOut',
  'leased-lands-in': 'leasedLandIn',
  'leased-buildings-out': 'leasedBuildingOut',
  'leased-buildings-in': 'leasedBuildingIn',
};

const getPathParts = (req) =>
  String(req.path || '')
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

const getEntityInfo = (moduleName, req) => {
  const parts = getPathParts(req);

  if (moduleName === 'records') {
    return {
      entity: parts[0] || 'record',
      entityId: parts[1] || null,
      prismaModel: recordsModelByResource[parts[0]] || null,
    };
  }

  if (moduleName === 'uploads') {
    return {
      entity: 'file',
      entityId: null,
      prismaModel: null,
    };
  }

  return {
    entity: moduleName,
    entityId: parts[0] || null,
    prismaModel: prismaModelByModule[moduleName] || null,
  };
};

const readPreviousData = async ({ prismaModel, entityId }) => {
  if (!prismaModel || !entityId || !prisma[prismaModel]) return null;

  try {
    return await prisma[prismaModel].findUnique({
      where: { id: entityId },
    });
  } catch {
    return null;
  }
};

const getEntityLabel = (value) => {
  if (!value || typeof value !== 'object') return null;

  return (
    value.deedNumber ||
    value.documentNumber ||
    value.contractNumber ||
    value.propertyDescription ||
    value.locationName ||
    value.title ||
    value.username ||
    value.originalName ||
    value.fileName ||
    null
  );
};

const getDescription = ({ action, moduleName, status }) => {
  const actionLabels = {
    create: 'إضافة',
    update: 'تعديل',
    delete: 'حذف',
    upload: 'رفع ملف',
  };

  const statusLabel = status === 'success' ? 'ناجحة' : 'فاشلة';

  return `${actionLabels[action] || action} في ${
    moduleLabels[moduleName] || moduleName
  } - ${statusLabel}`;
};

export const auditTrail = (moduleName) => {
  return async (req, res, next) => {
    const method = req.method.toUpperCase();
    const action =
      moduleName === 'uploads' && method === 'POST'
        ? 'upload'
        : actionByMethod[method];

    if (!action) {
      return next();
    }

    const entityInfo = getEntityInfo(moduleName, req);
    const previousData =
      action === 'update' || action === 'delete'
        ? await readPreviousData(entityInfo)
        : null;

    let responseBody;
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      const status =
        res.statusCode >= 200 && res.statusCode < 400
          ? 'success'
          : 'failed';

      const responseEntity =
        responseBody && typeof responseBody === 'object'
          ? responseBody
          : null;

      const entityId =
        entityInfo.entityId ||
        responseEntity?.id ||
        responseEntity?.attachment?.id ||
        null;

      const entityLabel =
        getEntityLabel(responseEntity) ||
        getEntityLabel(previousData) ||
        getEntityLabel(req.body);

      const errorMessage =
        status === 'failed'
          ? responseBody?.message || `HTTP ${res.statusCode}`
          : null;

      void createAuditLog({
        user: req.authUser,
        action,
        module: moduleName,
        entity: entityInfo.entity,
        entityId,
        entityLabel,
        status,
        description: getDescription({
          action,
          moduleName,
          status,
        }),
        previousData,
        newData:
          status === 'success'
            ? responseEntity || sanitizeAuditData(req.body)
            : undefined,
        metadata: {
          method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          requestBody:
            action === 'delete'
              ? undefined
              : sanitizeAuditData(req.body),
        },
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'],
        errorMessage,
      });
    });

    next();
  };
};
