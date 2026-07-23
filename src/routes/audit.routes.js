import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().trim().optional(),
  module: z.string().trim().optional(),
  status: z.string().trim().optional(),
  userId: z.string().trim().optional(),
  search: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

const buildWhere = (query) => {
  const where = {};

  if (query.action) where.action = query.action;
  if (query.module) where.module = query.module;
  if (query.status) where.status = query.status;
  if (query.userId) where.userId = query.userId;

  if (query.from || query.to) {
    where.createdAt = {};

    if (query.from) {
      const from = new Date(`${query.from}T00:00:00.000Z`);
      if (!Number.isNaN(from.getTime())) where.createdAt.gte = from;
    }

    if (query.to) {
      const to = new Date(`${query.to}T23:59:59.999Z`);
      if (!Number.isNaN(to.getTime())) where.createdAt.lte = to;
    }
  }

  if (query.search) {
    where.OR = [
      { username: { contains: query.search, mode: 'insensitive' } },
      { userEmail: { contains: query.search, mode: 'insensitive' } },
      { entityLabel: { contains: query.search, mode: 'insensitive' } },
      { entityId: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
      { ipAddress: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  return where;
};

router.get('/stats', async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      total,
      todayCount,
      createCount,
      updateCount,
      deleteCount,
      failedCount,
      loginFailedCount,
      activeUsers,
    ] = await Promise.all([
      prisma.auditLog.count(),
      prisma.auditLog.count({
        where: { createdAt: { gte: today } },
      }),
      prisma.auditLog.count({ where: { action: 'create' } }),
      prisma.auditLog.count({ where: { action: 'update' } }),
      prisma.auditLog.count({ where: { action: 'delete' } }),
      prisma.auditLog.count({ where: { status: 'failed' } }),
      prisma.auditLog.count({
        where: {
          action: 'login',
          status: 'failed',
        },
      }),
      prisma.auditLog.groupBy({
        by: ['userId'],
        where: {
          createdAt: { gte: today },
          userId: { not: null },
        },
      }),
    ]);

    res.json({
      total,
      today: todayCount,
      create: createCount,
      update: updateCount,
      delete: deleteCount,
      failed: failedCount,
      failedLogins: loginFailedCount,
      activeUsersToday: activeUsers.length,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/filters', async (_req, res, next) => {
  try {
    const [users, actions, modules] = await Promise.all([
      prisma.auditLog.findMany({
        where: { userId: { not: null } },
        distinct: ['userId'],
        select: {
          userId: true,
          username: true,
          userEmail: true,
        },
        orderBy: { username: 'asc' },
      }),
      prisma.auditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      }),
      prisma.auditLog.findMany({
        distinct: ['module'],
        select: { module: true },
        orderBy: { module: 'asc' },
      }),
    ]);

    res.json({
      users,
      actions: actions.map((item) => item.action),
      modules: modules.map((item) => item.module),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const query = querySchema.parse(req.query);
    const where = buildWhere(query);
    const skip = (query.page - 1) * query.limit;

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      items,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const item = await prisma.auditLog.findUnique({
      where: { id: req.params.id },
    });

    if (!item) {
      return res.status(404).json({
        message: 'سجل العملية غير موجود',
      });
    }

    res.json(item);
  } catch (error) {
    next(error);
  }
});

export default router;
