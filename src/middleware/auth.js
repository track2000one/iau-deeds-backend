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

export const requireAdminForWrites = (req, res, next) => {
  const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

  if (readMethods.has(req.method.toUpperCase())) {
    return next();
  }

  return requireAdmin(req, res, next);
};
