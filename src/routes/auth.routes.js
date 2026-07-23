import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import {
  serializeUser,
  signAccessToken,
  verifyPassword,
} from '../security/auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createAuditLog,
  getClientIp,
} from '../services/audit.service.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email('البريد الإلكتروني غير صحيح'),
  password: z.string().min(1, 'كلمة المرور مطلوبة'),
});

const auditLogin = (req, {
  user = null,
  email = null,
  status,
  errorMessage = null,
}) => {
  return createAuditLog({
    user,
    action: 'login',
    module: 'auth',
    entity: 'session',
    entityId: user?.id || null,
    entityLabel: user?.username || email,
    status,
    description:
      status === 'success'
        ? 'تسجيل دخول ناجح'
        : 'محاولة تسجيل دخول فاشلة',
    metadata: {
      email,
      path: req.originalUrl,
    },
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'],
    errorMessage,
  });
};

router.post('/login', async (req, res, next) => {
  let parsedEmail = null;

  try {
    const input = loginSchema.parse(req.body);
    const email = input.email.trim().toLowerCase();
    parsedEmail = email;

    const user = await prisma.appUser.findUnique({
      where: { email },
    });

    if (!user || !user.isActive) {
      await auditLogin(req, {
        email,
        status: 'failed',
        errorMessage: 'الحساب غير موجود أو غير نشط',
      });

      return res.status(401).json({
        message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
      });
    }

    const passwordIsValid = await verifyPassword(
      input.password,
      user.passwordHash
    );

    if (!passwordIsValid) {
      await auditLogin(req, {
        user,
        email,
        status: 'failed',
        errorMessage: 'كلمة المرور غير صحيحة',
      });

      return res.status(401).json({
        message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
      });
    }

    const updatedUser = await prisma.appUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await auditLogin(req, {
      user: updatedUser,
      email,
      status: 'success',
    });

    res.json({
      token: signAccessToken(updatedUser),
      user: serializeUser(updatedUser),
    });
  } catch (error) {
    if (parsedEmail || req.body?.email) {
      await auditLogin(req, {
        email: parsedEmail || String(req.body.email),
        status: 'failed',
        errorMessage: error?.message || 'بيانات الدخول غير صحيحة',
      });
    }

    next(error);
  }
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({
    user: serializeUser(req.authUser),
  });
});

router.post('/logout', requireAuth, async (req, res) => {
  await createAuditLog({
    user: req.authUser,
    action: 'logout',
    module: 'auth',
    entity: 'session',
    entityId: req.authUser.id,
    entityLabel: req.authUser.username,
    status: 'success',
    description: 'تسجيل خروج',
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'],
  });

  res.status(204).send();
});

export default router;
