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
  investments: 'المساحات والفرص الاستثمارية',
  vacant_lands: 'الأراضي الشاغرة',
  central_buildings: 'السجل المركزي للمباني',
};

const prismaModelByModule = {
  deeds: 'deed',
  vacant_lands: 'vacantLand',
  attachments: 'attachment',
  archive: 'archiveDocument',
  users: 'appUser',
  site_inspections: 'siteInspection',
  transaction_follow_up: 'transactionFollowUp',
  contracts_followup: 'contractFollowUp',
  assets: 'asset',
};

const mosqueModelsByResource = {
  buildings: 'mosqueBuilding',
  sites: 'mosqueSite',
  'field-tours': 'mosqueFieldTour',
  'field-visits': 'mosqueFieldVisit',
  personnel: 'mosquePersonnel',
  requests: 'mosqueRequest',
  tickets: 'mosqueTicket',
  leaves: 'mosqueLeave',
  jobs: 'mosqueJobApplication',
  'quran-warehouses': 'mosqueQuranWarehouse',
  'improvement-goals': 'mosqueImprovementGoal',
  'completion-tasks': 'mosqueCompletionTask',
};

const transactionModelsByResource = {
  risks: 'transactionFollowUpRiskRegister',
  'preventive-actions': 'transactionFollowUpPreventiveAction',
  'improvement-plans': 'transactionFollowUpImprovementPlan',
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

  if (moduleName === 'mosques' && parts[0] === 'buildings') {
    return {
      entity: 'central_building',
      entityId: parts[1] && parts[1] !== 'pending-imports' ? parts[1] : null,
      prismaModel: 'mosqueBuilding',
    };
  }

  if (moduleName === 'mosques' && mosqueModelsByResource[parts[0]]) {
    return {
      entity: parts[0],
      entityId: parts[1] || null,
      prismaModel: mosqueModelsByResource[parts[0]],
    };
  }

  if (moduleName === 'contracts_followup') {
    return {
      entity: 'contract',
      entityId: parts[0] || null,
      prismaModel: 'contractFollowUp',
      lookupKey: 'contractKey',
    };
  }

  if (moduleName === 'assets' && req.baseUrl?.endsWith('/cycles')) {
    return {
      entity: 'asset_cycle',
      entityId: parts[0] || null,
      prismaModel: 'assetUpdateCycle',
    };
  }

  if (moduleName === 'transaction_follow_up') {
    if (parts[0] === 'directives' && transactionModelsByResource[parts[1]]) {
      return {
        entity: parts[1],
        entityId: parts[2] || null,
        prismaModel: transactionModelsByResource[parts[1]],
      };
    }
    if (parts[0] === 'archived') {
      return { entity: 'transaction', entityId: parts[1] || null, prismaModel: 'transactionFollowUp' };
    }
    if (parts[0] === 'reports' || parts[0] === 'alerts' || parts[0] === 'directives') {
      return { entity: parts[0], entityId: null, prismaModel: null };
    }
    return {
      entity: 'transaction',
      entityId: parts[0] || null,
      prismaModel: 'transactionFollowUp',
    };
  }

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

const readPreviousData = async ({ prismaModel, entityId, lookupKey = 'id' }) => {
  if (!prismaModel || !entityId || !prisma[prismaModel]) return null;

  try {
    return await prisma[prismaModel].findUnique({
      where: { [lookupKey]: entityId },
    });
  } catch {
    return null;
  }
};

const getEntityLabel = (value) => {
  if (!value || typeof value !== 'object') return null;

  return (
    value.buildingNumber ||
    value.trackingNumber ||
    value.transactionNumber ||
    value.inspectionNumber ||
    value.tourNumber ||
    value.assetNumber ||
    value.subject ||
    value.siteName ||
    value.name ||
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
    // A preview is read-only; don't record it as an actual create operation.
    if (moduleName === 'vacant_lands' && method === 'POST' && req.path === '/import/preview') return next();
    const action =
      moduleName === 'uploads' && method === 'POST'
        ? 'upload'
        : actionByMethod[method];

    if (!action) {
      return next();
    }

    const entityInfo = getEntityInfo(moduleName, req);
    const effectiveModule = entityInfo.entity === 'central_building' ? 'central_buildings' : moduleName;
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
        module: effectiveModule,
        entity: entityInfo.entity,
        entityId,
        entityLabel,
        status,
        description: getDescription({
          action,
          moduleName: effectiveModule,
          status,
        }),
        previousData,
        newData:
          status === 'success'
            ? responseEntity || sanitizeAuditData(req.body)
            : undefined,
        metadata: {
          method,
          path: String(req.originalUrl || req.path).split('?')[0],
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
