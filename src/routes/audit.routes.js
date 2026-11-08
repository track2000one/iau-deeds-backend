import { Router } from 'express';
import { once } from 'node:events';
import { z } from 'zod';
import XLSX from 'xlsx';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';

const router = Router();
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BATCH_SIZE = 750;
const MAX_EXCEL_ROWS = 30000;
const RIYADH_OFFSET = '+03:00';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().trim().max(100).optional(),
  module: z.string().trim().max(100).optional(),
  status: z.enum(['success', 'failed']).optional(),
  userId: z.string().trim().max(200).optional(),
  search: z.string().trim().max(200).optional(),
  from: z.string().regex(DATE_PATTERN).optional(),
  to: z.string().regex(DATE_PATTERN).optional(),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: 'custom', message: 'تاريخ البداية يجب أن يسبق تاريخ النهاية', path: ['to'] });
  }
});

const parseQuery = (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: 'معايير التصفية غير صحيحة. تحقق من التواريخ والقيم المدخلة.' });
    return null;
  }
  return parsed.data;
};

const parseRiyadhDay = (day, nextDay = false) => {
  if (!day) return null;
  const date = new Date(`${day}T00:00:00${RIYADH_OFFSET}`);
  if (Number.isNaN(date.getTime()) || new Date(date.getTime() + 3 * 3600000).toISOString().slice(0, 10) !== day) {
    return null;
  }
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
};

const buildWhere = (query) => {
  const where = {};
  if (query.action) where.action = query.action;
  if (query.module) where.module = query.module;
  if (query.status) where.status = query.status;
  if (query.userId) where.userId = query.userId;
  if (query.from || query.to) {
    const gte = parseRiyadhDay(query.from);
    const lt = parseRiyadhDay(query.to, true);
    if (gte || lt) {
      where.createdAt = {};
      if (gte) where.createdAt.gte = gte;
      if (lt) where.createdAt.lt = lt;
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

const nowRiyadh = () => {
  const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  return parseRiyadhDay(today);
};

const riyadhDateTime = (value) => value
  ? new Date(value).toLocaleString('ar-SA-u-nu-latn', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  })
  : '';

const exportColumns = [
  'التاريخ والوقت (الرياض)', 'المستخدم', 'البريد الإلكتروني', 'الدور',
  'العملية', 'القسم', 'معرف السجل', 'اسم السجل', 'الحالة',
  'عنوان IP', 'الوصف', 'سبب الفشل',
];
const exportRow = (item) => [
  riyadhDateTime(item.createdAt), item.username || '', item.userEmail || '',
  item.userRole || '', item.action, item.module, item.entityId || '',
  item.entityLabel || '', item.status, item.ipAddress || '',
  item.description || '', item.errorMessage || '',
];
const safeCell = (value) => {
  let s = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '');
  if (/^[=+@\-]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

const exportAuditAccess = (req, format, filters, exportedCount) =>
  createAuditLog({
    user: req.authUser,
    action: 'export',
    module: 'audit',
    entity: 'report',
    status: 'success',
    description: `تصدير سجل الرقابة بصيغة ${format.toUpperCase()} (${exportedCount} سجل)`,
    metadata: { format, filters, exportedCount },
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'],
  });

router.get('/stats', async (req, res, next) => {
  try {
    const query = parseQuery(req, res);
    if (!query) return;
    const where = buildWhere(query);
    const todayWhere = { AND: [where, { createdAt: { gte: nowRiyadh() } }] };
    const [
      total, todayCount, createCount, updateCount, deleteCount,
      failedCount, loginFailedCount, activeUsers,
    ] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.count({ where: todayWhere }),
      prisma.auditLog.count({ where: { AND: [where, { action: 'create' }] } }),
      prisma.auditLog.count({ where: { AND: [where, { action: 'update' }] } }),
      prisma.auditLog.count({ where: { AND: [where, { action: 'delete' }] } }),
      prisma.auditLog.count({ where: { AND: [where, { status: 'failed' }] } }),
      prisma.auditLog.count({ where: { AND: [where, { action: 'login', status: 'failed' }] } }),
      prisma.auditLog.groupBy({
        by: ['userId'],
        where: { AND: [where, { createdAt: { gte: nowRiyadh() }, userId: { not: null } }] },
      }),
    ]);
    res.json({
      total, today: todayCount, create: createCount, update: updateCount,
      delete: deleteCount, failed: failedCount,
      failedLogins: loginFailedCount, activeUsersToday: activeUsers.length,
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
        select: { userId: true, username: true, userEmail: true },
        orderBy: { username: 'asc' },
      }),
      prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
      prisma.auditLog.findMany({ distinct: ['module'], select: { module: true }, orderBy: { module: 'asc' } }),
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

// A per-user audit profile, grouped from server-side records, never from a loaded table page.
router.get('/users-summary', async (req, res, next) => {
  try {
    const query = parseQuery(req, res);
    if (!query) return;
    const where = { AND: [buildWhere(query), { userId: { not: null } }] };
    const groups = await prisma.auditLog.groupBy({
      by: ['userId', 'username', 'userEmail', 'action', 'status'],
      where,
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const summaries = new Map();
    for (const row of groups) {
      const id = row.userId;
      if (!id) continue;
      let user = summaries.get(id);
      if (!user) {
        user = {
          userId: id, username: row.username || 'مستخدم', userEmail: row.userEmail || '',
          total: 0, login: 0, logout: 0, create: 0, update: 0,
          delete: 0, upload: 0, failed: 0, lastActivityAt: null,
        };
        summaries.set(id, user);
      }
      const count = row._count._all;
      user.total += count;
      if (row.action in user && typeof user[row.action] === 'number') user[row.action] += count;
      if (row.status === 'failed') user.failed += count;
      if (row._max.createdAt && (!user.lastActivityAt || row._max.createdAt > user.lastActivityAt)) {
        user.lastActivityAt = row._max.createdAt;
        user.username = row.username || user.username;
        user.userEmail = row.userEmail || user.userEmail;
      }
    }
    const users = Array.from(summaries.values()).sort((a, b) => b.total - a.total);
    res.json({ users, totalUsers: users.length });
  } catch (error) {
    next(error);
  }
});

// Full matching export: CSV streams in bounded batches and Excel is explicitly size-limited.
router.get('/export', async (req, res, next) => {
  try {
    const query = parseQuery(req, res);
    if (!query) return;
    const format = req.query.format === 'xlsx' ? 'xlsx' : req.query.format === 'csv' ? 'csv' : null;
    if (!format) return res.status(400).json({ message: 'صيغة التقرير المطلوبة غير مدعومة.' });

    const where = buildWhere(query);
    const total = await prisma.auditLog.count({ where });
    if (format === 'xlsx' && total > MAX_EXCEL_ROWS) {
      return res.status(413).json({
        message: `تجاوز التقرير الحد المخصص لملف Excel (${MAX_EXCEL_ROWS} سجل). استخدم تصدير CSV للحصول على جميع النتائج.`,
      });
    }

    const filename = `iau-user-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.write('\uFEFF' + exportColumns.map(safeCell).join(',') + '\r\n');
      let cursor;
      let written = 0;
      while (!res.destroyed) {
        const batch = await prisma.auditLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: BATCH_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true, createdAt: true, username: true, userEmail: true, userRole: true,
            action: true, module: true, entityId: true, entityLabel: true, status: true,
            ipAddress: true, description: true, errorMessage: true,
          },
        });
        if (batch.length === 0) break;
        for (const item of batch) {
          if (res.destroyed) break;
          const chunk = exportRow(item).map(safeCell).join(',') + '\r\n';
          if (!res.write(chunk)) await once(res, 'drain');
          written++;
        }
        cursor = batch[batch.length - 1].id;
        if (batch.length < BATCH_SIZE) break;
      }
      if (!res.destroyed) {
        res.end();
        void exportAuditAccess(req, format, query, written);
      }
      return;
    }

    const rows = [exportColumns];
    let cursor;
    while (rows.length - 1 < total) {
      const batch = await prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, createdAt: true, username: true, userEmail: true, userRole: true,
          action: true, module: true, entityId: true, entityLabel: true, status: true,
          ipAddress: true, description: true, errorMessage: true,
        },
      });
      if (!batch.length) break;
      rows.push(...batch.map(exportRow));
      cursor = batch[batch.length - 1].id;
      if (batch.length < BATCH_SIZE) break;
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [25, 24, 32, 15, 20, 25, 24, 35, 15, 20, 44, 44].map((wch) => ({ wch }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'سجل العمليات');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
    void exportAuditAccess(req, format, query, rows.length - 1);
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed) res.end();
      return;
    }
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const query = parseQuery(req, res);
    if (!query) return;
    const where = buildWhere(query);
    const skip = (query.page - 1) * query.limit;
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({
      items, page: query.page, limit: query.limit,
      total, totalPages: Math.max(1, Math.ceil(total / query.limit)),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const item = await prisma.auditLog.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ message: 'سجل العملية غير موجود' });
    res.json(item);
  } catch (error) {
    next(error);
  }
});

export default router;
