import { prisma } from './prisma.js';
import { hashPassword } from './security/auth.js';

export const ensureBootstrapAdmin = async () => {
  const adminCount = await prisma.appUser.count({
    where: {
      role: 'admin',
      isActive: true,
    },
  });

  if (adminCount > 0) {
    return;
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim();
  const username =
    process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'مسؤول المنصة';

  if (!email || !password) {
    console.warn(
      'No active admin exists. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD.'
    );
    return;
  }

  if (password.length < 8) {
    throw new Error(
      'BOOTSTRAP_ADMIN_PASSWORD must contain at least 8 characters.'
    );
  }

  const passwordHash = await hashPassword(password);

  await prisma.appUser.upsert({
    where: { email },
    update: {
      username,
      passwordHash,
      role: 'admin',
      isActive: true,
    },
    create: {
      username,
      email,
      passwordHash,
      role: 'admin',
      isActive: true,
    },
  });

  console.log(`Bootstrap admin is ready: ${email}`);
};
