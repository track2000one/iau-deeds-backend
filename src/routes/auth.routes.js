import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import {
  serializeUser,
  signAccessToken,
  verifyPassword,
} from '../security/auth.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email('البريد الإلكتروني غير صحيح'),
  password: z.string().min(1, 'كلمة المرور مطلوبة'),
});

router.post('/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const email = input.email.trim().toLowerCase();

    const user = await prisma.appUser.findUnique({
      where: { email },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
      });
    }

    const passwordIsValid = await verifyPassword(
      input.password,
      user.passwordHash
    );

    if (!passwordIsValid) {
      return res.status(401).json({
        message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
      });
    }

    const updatedUser = await prisma.appUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.json({
      token: signAccessToken(updatedUser),
      user: serializeUser(updatedUser),
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

export default router;
