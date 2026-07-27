import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import {
  hashPassword,
  serializeUser,
  signAccessToken,
  verifyPassword,
} from '../security/auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createAuditLog,
  getClientIp,
} from '../services/audit.service.js';
import { sendPasswordResetEmail } from '../services/email.service.js';

const router = Router();

const RESET_TOKEN_MINUTES = Math.max(
  10,
  Number(process.env.PASSWORD_RESET_TOKEN_MINUTES || 30)
);

const FRONTEND_URL = (
  process.env.FRONTEND_URL ||
  'http://localhost:5173'
).replace(/\/+$/, '');

const loginSchema = z.object({
  email: z.string().email('البريد الإلكتروني غير صحيح'),
  password: z.string().min(1, 'كلمة المرور مطلوبة'),
});


const activateAccountSchema = z.object({
  token: z.string().min(32, 'رابط التفعيل غير صالح'),
  currentPassword: z.string().min(1, 'كلمة المرور الحالية مطلوبة'),
  keepCurrentPassword: z.boolean().default(true),
  newPassword: z
    .string()
    .min(8, 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف')
    .max(128, 'كلمة المرور الجديدة طويلة جدًا')
    .optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('البريد الإلكتروني غير صحيح'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(32, 'رابط إعادة التعيين غير صالح'),
  password: z
    .string()
    .min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف')
    .max(128, 'كلمة المرور طويلة جدًا'),
});

const auditLogin = (
  req,
  {
    user = null,
    email = null,
    status,
    errorMessage = null,
  }
) =>
  createAuditLog({
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

const hashResetToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const waitMinimumResponseTime = async (startedAt, minimumMs = 450) => {
  const elapsed = Date.now() - startedAt;
  const remaining = minimumMs - elapsed;

  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
};

router.post('/login', async (req, res, next) => {
  let parsedEmail = null;

  try {
    const input = loginSchema.parse(req.body);
    const email = input.email.trim().toLowerCase();
    parsedEmail = email;

    const user = await prisma.appUser.findUnique({
      where: { email },
      include: { permissions: true },
    });

    if (!user) {
      await auditLogin(req, {
        email,
        status: 'failed',
        errorMessage: 'الحساب غير موجود',
      });

      return res.status(401).json({
        message: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      });
    }

    if (!user.isActive) {
      await auditLogin(req, {
        user,
        email,
        status: 'failed',
        errorMessage: 'الحساب غير مفعّل',
      });

      if (user.activationTokenHash) {
        const expired =
          !user.activationExpires ||
          user.activationExpires <= new Date();

        return res.status(403).json({
          code: expired
            ? 'ACTIVATION_EXPIRED'
            : 'ACTIVATION_REQUIRED',
          message: expired
            ? 'انتهت صلاحية رابط التفعيل. يرجى التواصل مع مسؤول النظام لإرسال رابط جديد.'
            : 'الحساب غير مفعّل. يرجى فتح رابط التفعيل المرسل إلى بريدك الإلكتروني.',
        });
      }

      return res.status(403).json({
        code: 'ACCOUNT_DISABLED',
        message:
          'الحساب معطّل. يرجى التواصل مع مدير النظام.',
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
        message: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      });
    }

    const updatedUser = await prisma.appUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
      include: { permissions: true },
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


router.get('/activate-account/validate', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');

    if (token.length < 32) {
      return res.status(400).json({
        valid: false,
        message: 'رابط التفعيل غير صالح.',
      });
    }

    const tokenHash = hashResetToken(token);

    const user = await prisma.appUser.findUnique({
      where: {
        activationTokenHash: tokenHash,
      },
    });

    if (!user || user.isActive || !user.activationTokenHash) {
      return res.status(400).json({
        valid: false,
        message:
          'رابط التفعيل غير صالح أو تم استخدامه مسبقًا.',
      });
    }

    if (
      !user.activationExpires ||
      user.activationExpires <= new Date()
    ) {
      return res.status(400).json({
        valid: false,
        expired: true,
        message:
          'انتهت صلاحية رابط التفعيل. يرجى التواصل مع مسؤول النظام لإرسال رابط جديد.',
      });
    }

    return res.json({
      valid: true,
      username: user.username,
      email: user.email,
      expiresAt: user.activationExpires,
      message: 'رابط التفعيل صالح.',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/activate-account', async (req, res, next) => {
  try {
    const input = activateAccountSchema.parse(req.body);

    if (!input.keepCurrentPassword && !input.newPassword) {
      return res.status(400).json({
        message: 'أدخل كلمة المرور الجديدة.',
      });
    }

    const tokenHash = hashResetToken(input.token);

    const user = await prisma.appUser.findUnique({
      where: {
        activationTokenHash: tokenHash,
      },
      include: {
        permissions: true,
      },
    });

    if (!user || user.isActive || !user.activationTokenHash) {
      return res.status(400).json({
        message:
          'رابط التفعيل غير صالح أو تم استخدامه مسبقًا.',
      });
    }

    if (
      !user.activationExpires ||
      user.activationExpires <= new Date()
    ) {
      return res.status(400).json({
        message:
          'انتهت صلاحية رابط التفعيل. يرجى التواصل مع مسؤول النظام لإرسال رابط جديد.',
      });
    }

    const currentPasswordIsValid = await verifyPassword(
      input.currentPassword,
      user.passwordHash
    );

    if (!currentPasswordIsValid) {
      return res.status(400).json({
        message:
          'كلمة المرور المرسلة إلى بريدك الإلكتروني غير صحيحة.',
      });
    }

    const passwordHash = input.keepCurrentPassword
      ? user.passwordHash
      : await hashPassword(input.newPassword);

    const activatedUser = await prisma.appUser.update({
      where: { id: user.id },
      data: {
        passwordHash,
        isActive: true,
        activationTokenHash: null,
        activationExpires: null,
        activatedAt: new Date(),
      },
      include: {
        permissions: true,
      },
    });

    await createAuditLog({
      user: activatedUser,
      action: 'account_activated',
      module: 'auth',
      entity: 'account',
      entityId: activatedUser.id,
      entityLabel: activatedUser.username,
      status: 'success',
      description: input.keepCurrentPassword
        ? 'تم تفعيل الحساب مع الاحتفاظ بكلمة المرور'
        : 'تم تفعيل الحساب وتعيين كلمة مرور جديدة',
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      message: input.keepCurrentPassword
        ? 'تم تفعيل الحساب بنجاح. يمكنك الآن تسجيل الدخول بكلمة المرور الحالية.'
        : 'تم تفعيل الحساب وتعيين كلمة المرور الجديدة بنجاح.',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/forgot-password', async (req, res, next) => {
  const startedAt = Date.now();
  let email = null;

  try {
    const input = forgotPasswordSchema.parse(req.body);
    email = input.email.trim().toLowerCase();

    const user = await prisma.appUser.findUnique({
      where: { email },
    });

    if (!user) {
      await waitMinimumResponseTime(startedAt);

      return res.status(404).json({
        message: 'هذا البريد الإلكتروني غير مسجل في المنصة.',
      });
    }

    if (!user.isActive) {
      await waitMinimumResponseTime(startedAt);

      return res.status(403).json({
        message:
          'الحساب المرتبط بهذا البريد غير مفعّل. يرجى التواصل مع مدير النظام.',
      });
    }

    {
      const recentRequest = await prisma.passwordResetToken.findFirst({
        where: {
          userId: user.id,
          createdAt: {
            gte: new Date(Date.now() - 60_000),
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!recentRequest) {
        const plainToken = crypto.randomBytes(48).toString('hex');
        const tokenHash = hashResetToken(plainToken);
        const expiresAt = new Date(
          Date.now() + RESET_TOKEN_MINUTES * 60_000
        );

        await prisma.$transaction(async (tx) => {
          await tx.passwordResetToken.deleteMany({
            where: {
              userId: user.id,
              OR: [
                { usedAt: { not: null } },
                { expiresAt: { lt: new Date() } },
              ],
            },
          });

          await tx.passwordResetToken.create({
            data: {
              userId: user.id,
              tokenHash,
              expiresAt,
              requestedIp: getClientIp(req),
              userAgent: req.headers['user-agent'] || null,
            },
          });
        });

        const resetUrl =
          `${FRONTEND_URL}/#/reset-password?token=` +
          encodeURIComponent(plainToken);

        try {
          await sendPasswordResetEmail({
            to: user.email,
            username: user.username,
            resetUrl,
            expiresInMinutes: RESET_TOKEN_MINUTES,
          });

          await createAuditLog({
            user,
            action: 'password_reset_requested',
            module: 'auth',
            entity: 'password',
            entityId: user.id,
            entityLabel: user.username,
            status: 'success',
            description: 'تم إرسال رابط إعادة تعيين كلمة المرور',
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent'],
          });
        } catch (emailError) {
          await prisma.passwordResetToken.deleteMany({
            where: { tokenHash },
          });

          await createAuditLog({
            user,
            action: 'password_reset_requested',
            module: 'auth',
            entity: 'password',
            entityId: user.id,
            entityLabel: user.username,
            status: 'failed',
            description: 'فشل إرسال رابط إعادة تعيين كلمة المرور',
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent'],
            errorMessage: emailError?.message || 'Email delivery failed',
          });

          console.error('Password reset email failed:', emailError);
        }
      }
    }

    await waitMinimumResponseTime(startedAt);

    return res.json({
      message:
        'تم إرسال رابط إعادة تعيين كلمة المرور إلى البريد الإلكتروني المسجل.',
    });
  } catch (error) {
    if (error?.name === 'ZodError') {
      await waitMinimumResponseTime(startedAt);
      return res.status(400).json({
        message: 'أدخل بريدًا إلكترونيًا صحيحًا',
      });
    }

    next(error);
  }
});

router.get('/reset-password/validate', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');

    if (token.length < 32) {
      return res.status(400).json({
        valid: false,
        message: 'رابط إعادة التعيين غير صالح',
      });
    }

    const resetToken = await prisma.passwordResetToken.findUnique({
      where: {
        tokenHash: hashResetToken(token),
      },
    });

    const valid = Boolean(
      resetToken &&
        !resetToken.usedAt &&
        resetToken.expiresAt > new Date()
    );

    return res.status(valid ? 200 : 400).json({
      valid,
      message: valid
        ? 'الرابط صالح'
        : 'انتهت صلاحية الرابط أو تم استخدامه مسبقًا',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const input = resetPasswordSchema.parse(req.body);
    const tokenHash = hashResetToken(input.token);

    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (
      !resetToken ||
      resetToken.usedAt ||
      resetToken.expiresAt <= new Date() ||
      !resetToken.user.isActive
    ) {
      return res.status(400).json({
        message: 'انتهت صلاحية الرابط أو تم استخدامه مسبقًا',
      });
    }

    const newPasswordHash = await hashPassword(input.password);

    await prisma.$transaction(async (tx) => {
      await tx.appUser.update({
        where: { id: resetToken.userId },
        data: {
          passwordHash: newPasswordHash,
        },
      });

      await tx.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      });

      await tx.passwordResetToken.deleteMany({
        where: {
          userId: resetToken.userId,
          id: { not: resetToken.id },
        },
      });
    });

    await createAuditLog({
      user: resetToken.user,
      action: 'password_reset_completed',
      module: 'auth',
      entity: 'password',
      entityId: resetToken.user.id,
      entityLabel: resetToken.user.username,
      status: 'success',
      description: 'تمت إعادة تعيين كلمة المرور بواسطة رابط البريد',
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message:
        'تم تغيير كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.',
    });
  } catch (error) {
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
