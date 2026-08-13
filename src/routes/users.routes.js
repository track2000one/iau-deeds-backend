import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { hashPassword, serializeUser } from '../security/auth.js';
import { sendAccountActivationEmail } from '../services/email.service.js';

const router = Router();

const ACTIVATION_TOKEN_HOURS = Math.max(
  1,
  Number(process.env.ACCOUNT_ACTIVATION_TOKEN_HOURS || 24)
);

const FRONTEND_URL = (
  process.env.FRONTEND_URL ||
  'http://localhost:5173'
).replace(/\/+$/, '');

const hashActivationToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const createActivationData = () => {
  const plainToken = crypto.randomBytes(48).toString('hex');

  return {
    plainToken,
    tokenHash: hashActivationToken(plainToken),
    expiresAt: new Date(
      Date.now() + ACTIVATION_TOKEN_HOURS * 60 * 60 * 1000
    ),
  };
};

const buildActivationUrl = (plainToken) =>
  `${FRONTEND_URL}/#/activate-account?token=${encodeURIComponent(
    plainToken
  )}`;


router.use(requireAuth, requireAdmin);

const roleSchema = z.enum(['admin', 'employee']);

const permissionSchema = z.object({
  canView: z.boolean().default(false),
  canAdd: z.boolean().default(false),
  canEdit: z.boolean().default(false),
  canDelete: z.boolean().default(false),
  canPrint: z.boolean().default(false),
  canCreateUser: z.boolean().default(false),
});

const permissionsSchema = z.record(z.string(), permissionSchema).default({});

const createUserSchema = z.object({
  username: z.string().trim().min(2, 'اسم المستخدم قصير جدًا'),
  email: z.string().email('البريد الإلكتروني غير صحيح'),
  password: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف'),
  role: roleSchema.default('employee'),
  permissions: permissionsSchema,
});

const updateUserSchema = z.object({
  username: z.string().trim().min(2, 'اسم المستخدم قصير جدًا'),
  email: z.string().email('البريد الإلكتروني غير صحيح'),
  role: roleSchema,
  isActive: z.boolean(),
  permissions: permissionsSchema,
});

const passwordSchema = z.object({
  password: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف'),
});

const normalizePermissionRows = (permissions = {}) =>
  Object.entries(permissions).map(([module, value]) => ({
    module,
    canView:
      Boolean(value.canView) ||
      Boolean(value.canAdd) ||
      Boolean(value.canEdit) ||
      Boolean(value.canDelete) ||
      Boolean(value.canPrint) ||
      Boolean(value.canCreateUser),
    canAdd: Boolean(value.canAdd),
    canEdit: Boolean(value.canEdit),
    canDelete: Boolean(value.canDelete),
    canPrint: Boolean(value.canPrint),
    canCreateUser: Boolean(value.canCreateUser),
  }));

const countOtherActiveAdmins = async (userId) =>
  prisma.appUser.count({
    where: {
      id: { not: userId },
      role: 'admin',
      isActive: true,
    },
  });

const includePermissions = {
  permissions: true,
};

router.get('/', async (_req, res, next) => {
  try {
    const users = await prisma.appUser.findMany({
      include: includePermissions,
      orderBy: [
        { role: 'asc' },
        { username: 'asc' },
      ],
    });

    res.json(users.map(serializeUser));
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  let createdUserId = null;

  try {
    const input = createUserSchema.parse(req.body);
    const email = input.email.trim().toLowerCase();

    const existing = await prisma.appUser.findUnique({
      where: { email },
    });

    if (existing) {
      return res.status(409).json({
        message: 'يوجد حساب مسجل بهذا البريد الإلكتروني مسبقًا',
      });
    }

    const rows =
      input.role === 'admin'
        ? []
        : normalizePermissionRows(input.permissions);

    const activation = createActivationData();

    const user = await prisma.appUser.create({
      data: {
        username: input.username,
        email,
        passwordHash: await hashPassword(input.password),
        role: input.role,
        isActive: false,
        activationTokenHash: activation.tokenHash,
        activationExpires: activation.expiresAt,
        activationSentAt: new Date(),
        activatedAt: null,
        permissions: {
          create: rows,
        },
      },
      include: includePermissions,
    });

    createdUserId = user.id;

    await sendAccountActivationEmail({
      to: user.email,
      username: user.username,
      initialPassword: input.password,
      activationUrl: buildActivationUrl(activation.plainToken),
      expiresInHours: ACTIVATION_TOKEN_HOURS,
      includePassword: true,
    });

    res.status(201).json({
      ...serializeUser(user),
      message:
        'تم إنشاء الحساب وإرسال رسالة التفعيل إلى البريد الإلكتروني.',
    });
  } catch (error) {
    if (createdUserId) {
      try {
        await prisma.appUser.delete({
          where: { id: createdUserId },
        });
      } catch (rollbackError) {
        console.error(
          'Unable to rollback user after activation email failure:',
          rollbackError
        );
      }
    }

    next(error);
  }
});

router.post('/:id/resend-activation', async (req, res, next) => {
  let previousActivationState = null;

  try {
    const user = await prisma.appUser.findUnique({
      where: { id: req.params.id },
      include: includePermissions,
    });

    if (!user) {
      return res.status(404).json({
        message: 'المستخدم غير موجود',
      });
    }

    if (user.isActive) {
      return res.status(400).json({
        message: 'الحساب نشط بالفعل ولا يحتاج إلى رابط تفعيل جديد.',
      });
    }

    previousActivationState = {
      userId: user.id,
      activationTokenHash: user.activationTokenHash,
      activationExpires: user.activationExpires,
      activationSentAt: user.activationSentAt,
    };

    const activation = createActivationData();
    const sentAt = new Date();

    const updated = await prisma.appUser.update({
      where: { id: user.id },
      data: {
        isActive: false,
        activationTokenHash: activation.tokenHash,
        activationExpires: activation.expiresAt,
        activationSentAt: sentAt,
        activatedAt: null,
      },
      include: includePermissions,
    });

    try {
      await sendAccountActivationEmail({
        to: updated.email,
        username: updated.username,
        initialPassword: null,
        activationUrl: buildActivationUrl(activation.plainToken),
        expiresInHours: ACTIVATION_TOKEN_HOURS,
        includePassword: false,
      });
    } catch (emailError) {
      await prisma.appUser.update({
        where: { id: user.id },
        data: {
          activationTokenHash:
            previousActivationState.activationTokenHash,
          activationExpires:
            previousActivationState.activationExpires,
          activationSentAt:
            previousActivationState.activationSentAt,
        },
      });

      throw emailError;
    }

    res.json({
      user: serializeUser(updated),
      message:
        `تم إرسال رابط تفعيل جديد صالح لمدة ${ACTIVATION_TOKEN_HOURS} ساعة.`,
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const input = updateUserSchema.parse(req.body);
    const userId = req.params.id;
    const email = input.email.trim().toLowerCase();

    const current = await prisma.appUser.findUnique({
      where: { id: userId },
    });

    if (!current) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    if (
      req.authUser.id === userId &&
      (input.role !== 'admin' || input.isActive === false)
    ) {
      return res.status(400).json({
        message: 'لا يمكن للمسؤول إلغاء صلاحية حسابه الحالي أو تعطيله',
      });
    }

    const removingAdmin =
      current.role === 'admin' &&
      current.isActive &&
      (input.role !== 'admin' || input.isActive === false);

    if (removingAdmin && (await countOtherActiveAdmins(userId)) === 0) {
      return res.status(400).json({
        message: 'لا يمكن إزالة أو تعطيل آخر مسؤول نشط في النظام',
      });
    }

    const emailOwner = await prisma.appUser.findFirst({
      where: {
        email,
        id: { not: userId },
      },
    });

    if (emailOwner) {
      return res.status(409).json({
        message: 'البريد الإلكتروني مستخدم في حساب آخر',
      });
    }

    const rows =
      input.role === 'admin'
        ? []
        : normalizePermissionRows(input.permissions);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.userPermission.deleteMany({
        where: { userId },
      });

      return tx.appUser.update({
        where: { id: userId },
        data: {
          username: input.username,
          email,
          role: input.role,
          isActive: input.isActive,

          // حالة الحساب الإدارية مستقلة عن مدة صلاحية رابط التفعيل.
          // عند تنشيط الحساب مباشرة من المسؤول، يتم إلغاء أي رابط قديم
          // ومنع النظام من إرجاع الحساب تلقائيًا إلى «معطل».
          activationTokenHash: input.isActive
            ? null
            : current.activationTokenHash,
          activationExpires: input.isActive
            ? null
            : current.activationExpires,
          activationSentAt: input.isActive
            ? current.activationSentAt
            : current.activationSentAt,
          activatedAt: input.isActive
            ? current.activatedAt || new Date()
            : current.activatedAt,

          permissions: {
            create: rows,
          },
        },
        include: includePermissions,
      });
    });

    res.json(serializeUser(updated));
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/password', async (req, res, next) => {
  try {
    const input = passwordSchema.parse(req.body);

    const user = await prisma.appUser.findUnique({
      where: { id: req.params.id },
    });

    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    await prisma.appUser.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(input.password),
      },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const userId = req.params.id;

    if (req.authUser.id === userId) {
      return res.status(400).json({
        message: 'لا يمكن حذف الحساب المستخدم حاليًا',
      });
    }

    const user = await prisma.appUser.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    if (
      user.role === 'admin' &&
      user.isActive &&
      (await countOtherActiveAdmins(userId)) === 0
    ) {
      return res.status(400).json({
        message: 'لا يمكن حذف آخر مسؤول نشط في النظام',
      });
    }

    await prisma.appUser.delete({
      where: { id: userId },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
