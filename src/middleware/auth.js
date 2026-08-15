import { prisma } from '../prisma.js';
import { verifyAccessToken } from '../security/auth.js';

const getBearerToken = (authorizationHeader = '') => {
  const [scheme, token] = String(authorizationHeader).split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token.trim();
};

export const requireAuth = async (req, res, next) => {
  try {
    const token = getBearerToken(req.headers.authorization);

    if (!token) {
      return res.status(401).json({ message: 'يجب تسجيل الدخول أولًا' });
    }

    const payload = verifyAccessToken(token);

    const user = await prisma.appUser.findUnique({
      where: { id: payload.sub },
      include: { permissions: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        message: 'الحساب غير موجود أو تم تعطيله',
      });
    }

    req.authUser = user;
    next();
  } catch (error) {
    return res.status(401).json({
      message:
        error?.name === 'TokenExpiredError'
          ? 'انتهت جلسة الدخول، يرجى تسجيل الدخول مرة أخرى'
          : 'جلسة الدخول غير صالحة',
    });
  }
};

export const requireAdmin = (req, res, next) => {
  if (req.authUser?.role !== 'admin') {
    return res.status(403).json({
      message: 'هذه العملية متاحة للمسؤول فقط',
    });
  }

  next();
};

const actionByMethod = {
  GET: 'canView',
  HEAD: 'canView',
  OPTIONS: 'canView',
  POST: 'canAdd',
  PUT: 'canEdit',
  PATCH: 'canEdit',
  DELETE: 'canDelete',
};

const recordModuleByResource = {
  'allocated-lands': 'allocated_lands',
  'delivered-lands': 'delivered_lands',
  'leased-lands-out': 'leased_lands_out',
  'leased-lands-in': 'leased_lands_in',
  'leased-buildings-out': 'leased_buildings_out',
  'leased-buildings-in': 'leased_buildings_in',
};

const findPermission = (user, moduleName) =>
  user?.permissions?.find((item) => item.module === moduleName);

export const requirePermission = (moduleName) => (req, res, next) => {
  if (req.authUser?.role === 'admin') return next();

  const method = req.method.toUpperCase();
  const requestPath = String(req.path || req.originalUrl || '');
  let action = actionByMethod[method];

  if (
    moduleName === 'mosques' &&
    method === 'POST' &&
    /\/personnel\/account\/?(?:\?|$)/.test(requestPath)
  ) {
    action = 'canCreateUser';
  }

  // Lifecycle actions for accounting data cycles are approvals/reviews,
  // therefore they require edit authority rather than generic add authority.
  if (
    moduleName === 'accounting_transformation' &&
    method === 'POST' &&
    /\/(review|reopen|approve)\/?(?:\?|$)/.test(requestPath)
  ) {
    action = 'canEdit';
  }

  // Lifecycle actions for asset data cycles are review/approval actions.
  if (
    moduleName === 'assets' &&
    method === 'POST' &&
    /\/(review|reopen|approve)\/?(?:\?|$)/.test(requestPath)
  ) {
    action = 'canEdit';
  }

  const permission = findPermission(req.authUser, moduleName);

  if (!action || !permission?.[action]) {
    return res.status(403).json({
      message: 'لا تملك صلاحية تنفيذ هذه العملية',
    });
  }

  next();
};

export const requireRecordPermission = (req, res, next) => {
  if (req.authUser?.role === 'admin') return next();

  const resource = String(req.path || '')
    .split('/')
    .filter(Boolean)[0];

  const moduleName = recordModuleByResource[resource];

  if (!moduleName) {
    return res.status(403).json({
      message: 'تعذر تحديد صلاحية القسم المطلوب',
    });
  }

  return requirePermission(moduleName)(req, res, next);
};

export const requireAttachmentPermission = (req, res, next) => {
  if (req.authUser?.role === 'admin') return next();

  const entityType =
    req.body?.entityType ||
    String(req.path || '').split('/').filter(Boolean)[0];

  const map = {
    deed: 'deeds',
    allocated_land: 'allocated_lands',
    delivered_land: 'delivered_lands',
    leased_land_out: 'leased_lands_out',
    leased_land_in: 'leased_lands_in',
    leased_building_out: 'leased_buildings_out',
    leased_building_in: 'leased_buildings_in',
    site_inspection: 'site_inspections',
    asset: 'assets',
  };

  const moduleName = map[entityType];

  if (!moduleName) {
    return res.status(403).json({
      message: 'تعذر تحديد صلاحية المرفق',
    });
  }

  return requirePermission(moduleName)(req, res, next);
};

export const requireUploadPermission = (req, res, next) => {
  if (req.authUser?.role === 'admin') return next();

  const requestedModule = String(
    req.headers['x-upload-module'] || req.query?.module || ''
  ).trim();

  if (!requestedModule) {
    return res.status(403).json({
      message: 'تعذر تحديد صلاحية رفع الملف',
    });
  }

  const permission = findPermission(req.authUser, requestedModule);

  if (!permission?.canAdd && !permission?.canEdit) {
    return res.status(403).json({
      message: 'لا تملك صلاحية رفع الملفات لهذا القسم',
    });
  }

  next();
};
