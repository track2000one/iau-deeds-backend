import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { hashPassword, serializeUser } from '../security/auth.js';

const router = Router();

router.use(requireAuth, requireAdmin);

const roleSchema = z.enum(['admin', 'employee']);

const createUserSchema = z.object({
  username: z.string().trim().min(2, 'اسم المستخدم قصير جدًا'),
  email: z.string().email('البريد الإلكتروني غير صحيح'),
  password: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف'),
  role: roleSchema.default('employee'),
});

const updateUserSchema = z.object({
  username: z.string().trim().min(2, 'اسم المستخدم قصير جدًا'),
  email: z.string().email('البريد الإلكتروني غير صحيح'),
  role: roleSchema,
  isActive: z.boolean(),
});

const passwordSchema = z.object({
  password: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف'),
});

const countOtherActiveAdmins = async (userId) => {
  return prisma.appUser.count({
    where: {
      id: { not: userId },
      role: 'admin',
      isActive: true,
    },
  });
};

router.get('/', async (_req, res, next) => {
  try {
    const users = await prisma.appUser.findMany({
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

    const user = await prisma.appUser.create({
      data: {
        username: input.username,
        email,
        passwordHash: await hashPassword(input.password),
        role: input.role,
        isActive: true,
      },
    });

    res.status(201).json(serializeUser(user));
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

    if (req.authUser.id === userId) {
      if (input.role !== 'admin' || input.isActive === false) {
        return res.status(400).json({
          message: 'لا يمكن للمسؤول إلغاء صلاحية حسابه الحالي أو تعطيله',
        });
      }
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

    const updated = await prisma.appUser.update({
      where: { id: userId },
      data: {
        username: input.username,
        email,
        role: input.role,
        isActive: input.isActive,
      },
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
