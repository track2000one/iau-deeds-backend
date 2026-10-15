import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const OPEN_STATUSES = ['new', 'assigned', 'in_progress', 'waiting_response', 'needs_follow_up'];
const FINAL_STATUSES = ['completed', 'closed'];
const ALL_STATUSES = [...OPEN_STATUSES, ...FINAL_STATUSES];

const transactionTypeSchema = z.enum(['incoming', 'outgoing', 'internal']);
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const statusSchema = z.enum([
  'new',
  'assigned',
  'in_progress',
  'waiting_response',
  'needs_follow_up',
  'completed',
  'closed',
]);

const nullableText = (max = 5000) => z.string().trim().max(max).optional().nullable();

const createSchema = z.object({
  transactionNumber: z.string().trim().min(1, 'رقم المعاملة مطلوب').max(150),
  transactionDate: z.string().trim().min(1, 'تاريخ المعاملة مطلوب'),
  transactionType: transactionTypeSchema.default('incoming'),
  subject: z.string().trim().min(2, 'موضوع المعاملة مطلوب').max(1000),
  sourceEntity: nullableText(300),
  priority: prioritySchema.default('normal'),
  currentAssigneeUserId: nullableText(100),
  requiredAction: nullableText(2000),
  dueDate: nullableText(100),
  inactivityAlertDays: z.coerce.number().int().min(1).max(90).default(3),
  notes: nullableText(5000),
  relatedModule: nullableText(100),
  relatedEntityId: nullableText(150),
  relatedEntityLabel: nullableText(500),
});

const updateSchema = createSchema.partial();

const assignSchema = z.object({
  assigneeUserId: z.string().trim().min(1, 'الموظف المختص مطلوب'),
  note: nullableText(2000),
});

const actionSchema = z.object({
  actionText: z.string().trim().min(2, 'الإجراء المتخذ مطلوب').max(3000),
  note: nullableText(3000),
  status: statusSchema.optional(),
  requiredAction: nullableText(2000),
  dueDate: nullableText(100),
});

const toDate = (value, fieldName) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName} غير صحيح`);
    error.status = 400;
    throw error;
  }
  return parsed;
};

const actor = (req) => ({
  id: req.authUser?.id || null,
  name: req.authUser?.username || req.authUser?.email || 'مستخدم',
});

const modulePermission = (req) =>
  req.authUser?.permissions?.find((item) => item.module === 'transaction_follow_up');

const isSupervisor = (req) =>
  req.authUser?.role === 'admin' || Boolean(modulePermission(req)?.canDelete);

const canActOnRecord = (req, record) =>
  isSupervisor(req) ||
  record.createdById === req.authUser?.id ||
  record.currentAssigneeUserId === req.authUser?.id;

const canEditRecordMaster = (req, record) =>
  isSupervisor(req) || record.createdById === req.authUser?.id;

const denyRecordAccess = (res) =>
  res.status(403).json({ message: 'لا يمكنك تعديل هذه المعاملة لأنها ليست مسندة لك ولم تقم بإنشائها' });

const assigneeSelect = {
  id: true,
  username: true,
  email: true,
  role: true,
};

const resolveAssignee = async (userId) => {
  if (!userId) return null;
  const user = await prisma.appUser.findFirst({
    where: {
      id: userId,
      isActive: true,
      OR: [
        { role: 'admin' },
        { permissions: { some: { module: 'transaction_follow_up', canView: true } } },
      ],
    },
    select: assigneeSelect,
  });
  if (!user) {
    const error = new Error('الموظف المحدد غير متاح أو لا يملك صلاحية نظام المتابعة');
    error.status = 400;
    throw error;
  }
  return user;
};

const nextTrackingNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `FUP-${year}-`;
  const latest = await prisma.transactionFollowUp.findFirst({
    where: { trackingNumber: { startsWith: prefix } },
    orderBy: { trackingNumber: 'desc' },
    select: { trackingNumber: true },
  });
  const last = Number(latest?.trackingNumber?.slice(prefix.length) || 0);
  return `${prefix}${String(last + 1).padStart(6, '0')}`;
};

const computeIndicator = (record) => {
  if (FINAL_STATUSES.includes(record.status)) {
    return {
      indicator: 'completed',
      indicatorLabel: record.status === 'closed' ? 'مغلقة' : 'منجزة',
      indicatorSeverity: 'success',
      daysUntilDue: null,
      daysWithoutAction: 0,
    };
  }

  const now = new Date();
  const baseActivity = record.lastActionAt || record.assignedAt || record.createdAt;
  const daysWithoutAction = Math.max(
    0,
    Math.floor((now.getTime() - new Date(baseActivity).getTime()) / 86400000),
  );
  const daysUntilDue = record.dueDate
    ? Math.ceil((new Date(record.dueDate).getTime() - now.getTime()) / 86400000)
    : null;

  if (!record.currentAssigneeUserId) {
    return {
      indicator: 'unassigned',
      indicatorLabel: 'تحتاج إسناد',
      indicatorSeverity: 'danger',
      daysUntilDue,
      daysWithoutAction,
    };
  }
  if (daysUntilDue !== null && daysUntilDue < 0) {
    return {
      indicator: 'overdue',
      indicatorLabel: `متأخرة ${Math.abs(daysUntilDue)} يوم`,
      indicatorSeverity: 'danger',
      daysUntilDue,
      daysWithoutAction,
    };
  }
  if (record.status === 'needs_follow_up') {
    return {
      indicator: 'action_required',
      indicatorLabel: 'تحتاج إجراء',
      indicatorSeverity: 'danger',
      daysUntilDue,
      daysWithoutAction,
    };
  }
  if (daysWithoutAction >= (record.inactivityAlertDays || 3)) {
    return {
      indicator: 'inactive',
      indicatorLabel: `دون إجراء منذ ${daysWithoutAction} يوم`,
      indicatorSeverity: 'warning',
      daysUntilDue,
      daysWithoutAction,
    };
  }
  if (daysUntilDue !== null && daysUntilDue <= 2) {
    return {
      indicator: 'due_soon',
      indicatorLabel: daysUntilDue <= 0 ? 'مستحقة اليوم' : `تستحق خلال ${daysUntilDue} يوم`,
      indicatorSeverity: 'warning',
      daysUntilDue,
      daysWithoutAction,
    };
  }
  if (record.status === 'waiting_response') {
    return {
      indicator: 'waiting',
      indicatorLabel: 'بانتظار رد',
      indicatorSeverity: 'info',
      daysUntilDue,
      daysWithoutAction,
    };
  }
  return {
    indicator: 'on_track',
    indicatorLabel: 'ضمن المتابعة',
    indicatorSeverity: 'success',
    daysUntilDue,
    daysWithoutAction,
  };
};

const serialize = (record) => ({ ...record, ...computeIndicator(record) });

const saudiDayKey = (date = new Date()) =>
  new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

const getFollowUpSupervisorIds = async () => {
  const users = await prisma.appUser.findMany({
    where: {
      isActive: true,
      OR: [
        { role: 'admin' },
        { permissions: { some: { module: 'transaction_follow_up', canDelete: true } } },
      ],
    },
    select: { id: true },
  });
  return users.map((user) => user.id);
};

const createFollowUpAlert = async ({
  alertKey,
  transactionId,
  userId,
  kind,
  severity,
  title,
  message,
}) => {
  if (!userId) return null;
  return prisma.transactionFollowUpAlert.upsert({
    where: { alertKey },
    update: { title, message, severity },
    create: {
      alertKey,
      transactionId,
      userId,
      kind,
      severity,
      title,
      message,
    },
  });
};

const alertCopy = (record, indicator, escalated = false) => {
  const number = record.transactionNumber;
  const subject = record.subject;
  const prefix = escalated ? 'تصعيد متابعة' : 'تنبيه متابعة';

  if (indicator.indicator === 'unassigned') {
    return {
      kind: 'unassigned',
      severity: 'danger',
      title: 'معاملة تحتاج إسناد',
      message: `${number} — ${subject}. لم يتم إسناد المعاملة لموظف مختص.`,
    };
  }
  if (indicator.indicator === 'overdue') {
    return {
      kind: escalated ? 'overdue_escalation' : 'overdue',
      severity: 'danger',
      title: `${prefix}: معاملة متأخرة`,
      message: `${number} — ${subject}. ${indicator.indicatorLabel} ولم يتم إقفالها.`,
    };
  }
  if (indicator.indicator === 'action_required') {
    return {
      kind: escalated ? 'action_escalation' : 'action_required',
      severity: 'danger',
      title: `${prefix}: المعاملة تحتاج إجراء`,
      message: `${number} — ${subject}. الحالة الحالية تتطلب إجراء من الموظف المختص.`,
    };
  }
  if (indicator.indicator === 'inactive') {
    return {
      kind: escalated ? 'inactive_escalation' : 'inactive',
      severity: escalated ? 'danger' : 'warning',
      title: escalated ? 'تصعيد: معاملة دون تحديث' : 'معاملة دون تحديث',
      message: `${number} — ${subject}. ${indicator.indicatorLabel}.`,
    };
  }
  if (indicator.indicator === 'due_soon') {
    return {
      kind: 'due_soon',
      severity: 'warning',
      title: 'موعد استحقاق معاملة قريب',
      message: `${number} — ${subject}. ${indicator.indicatorLabel}.`,
    };
  }
  return null;
};

export const syncTransactionFollowUpAlerts = async () => {
  const rows = await prisma.transactionFollowUp.findMany({
    where: { status: { in: OPEN_STATUSES } },
    select: {
      id: true,
      transactionNumber: true,
      subject: true,
      status: true,
      currentAssigneeUserId: true,
      dueDate: true,
      assignedAt: true,
      lastActionAt: true,
      inactivityAlertDays: true,
      createdAt: true,
    },
  });

  if (!rows.length) return { scanned: 0, alerts: 0 };

  const supervisorIds = await getFollowUpSupervisorIds();
  const dayKey = saudiDayKey();
  let alerts = 0;

  for (const row of rows) {
    const indicator = computeIndicator(row);
    if (!['unassigned', 'overdue', 'action_required', 'inactive', 'due_soon'].includes(indicator.indicator)) continue;

    const recipients = new Map();

    if (indicator.indicator === 'unassigned') {
      supervisorIds.forEach((id) => recipients.set(id, true));
    } else {
      if (row.currentAssigneeUserId) recipients.set(row.currentAssigneeUserId, false);

      const escalate =
        indicator.indicator === 'overdue' ||
        indicator.indicator === 'action_required' ||
        (
          indicator.indicator === 'inactive' &&
          indicator.daysWithoutAction >= (row.inactivityAlertDays || 3) + 2
        );

      if (escalate) supervisorIds.forEach((id) => recipients.set(id, true));
    }

    for (const [userId, escalated] of recipients.entries()) {
      const copy = alertCopy(row, indicator, escalated);
      if (!copy) continue;
      await createFollowUpAlert({
        alertKey: `${row.id}:${copy.kind}:${dayKey}:${userId}`,
        transactionId: row.id,
        userId,
        ...copy,
      });
      alerts += 1;
    }
  }

  return { scanned: rows.length, alerts };
};

router.get('/assignees', async (_req, res, next) => {
  try {
    const users = await prisma.appUser.findMany({
      where: {
        isActive: true,
        OR: [
          { role: 'admin' },
          { permissions: { some: { module: 'transaction_follow_up', canView: true } } },
        ],
      },
      select: assigneeSelect,
      orderBy: [{ role: 'asc' }, { username: 'asc' }],
    });
    res.json(users);
  } catch (error) {
    next(error);
  }
});

router.get('/alerts', async (req, res, next) => {
  try {
    await syncTransactionFollowUpAlerts();
    const items = await prisma.transactionFollowUpAlert.findMany({
      where: { userId: req.authUser.id },
      include: {
        transaction: {
          select: {
            id: true,
            transactionNumber: true,
            trackingNumber: true,
            subject: true,
            status: true,
            currentAssigneeName: true,
            dueDate: true,
          },
        },
      },
      orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    });
    res.json(items);
  } catch (error) {
    next(error);
  }
});

router.patch('/alerts/read-all', async (req, res, next) => {
  try {
    const result = await prisma.transactionFollowUpAlert.updateMany({
      where: { userId: req.authUser.id, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    res.json({ updated: result.count });
  } catch (error) {
    next(error);
  }
});

router.patch('/alerts/:id/read', async (req, res, next) => {
  try {
    const alert = await prisma.transactionFollowUpAlert.findUnique({
      where: { id: req.params.id },
    });
    if (!alert) return res.status(404).json({ message: 'التنبيه غير موجود' });
    if (alert.userId !== req.authUser.id) {
      return res.status(403).json({ message: 'هذا التنبيه غير موجه إلى حسابك' });
    }
    res.json(await prisma.transactionFollowUpAlert.update({
      where: { id: alert.id },
      data: { isRead: true, readAt: new Date() },
    }));
  } catch (error) {
    next(error);
  }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const mine = String(req.query.mine || '').toLowerCase() === 'true';
    const baseWhere = mine ? { currentAssigneeUserId: req.authUser.id } : {};
    const now = new Date();

    const [total, open, waiting, overdue, completed, unassigned, openRows] = await Promise.all([
      prisma.transactionFollowUp.count({ where: baseWhere }),
      prisma.transactionFollowUp.count({ where: { ...baseWhere, status: { in: OPEN_STATUSES } } }),
      prisma.transactionFollowUp.count({ where: { ...baseWhere, status: 'waiting_response' } }),
      prisma.transactionFollowUp.count({
        where: { ...baseWhere, status: { in: OPEN_STATUSES }, dueDate: { lt: now } },
      }),
      prisma.transactionFollowUp.count({ where: { ...baseWhere, status: { in: FINAL_STATUSES } } }),
      prisma.transactionFollowUp.count({
        where: { ...baseWhere, status: { in: OPEN_STATUSES }, currentAssigneeUserId: null },
      }),
      prisma.transactionFollowUp.findMany({
        where: { ...baseWhere, status: { in: OPEN_STATUSES } },
        select: {
          id: true,
          status: true,
          currentAssigneeUserId: true,
          dueDate: true,
          assignedAt: true,
          lastActionAt: true,
          inactivityAlertDays: true,
          createdAt: true,
        },
      }),
    ]);

    const needsAction = openRows.filter((row) => {
      const indicator = computeIndicator(row);
      return ['unassigned', 'overdue', 'action_required', 'inactive', 'due_soon'].includes(indicator.indicator);
    }).length;

    res.json({ total, open, waiting, overdue, completed, unassigned, needsAction });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(req.query.pageSize || '30'), 10) || 30));
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const priority = String(req.query.priority || '').trim();
    const assigneeUserId = String(req.query.assigneeUserId || '').trim();
    const mine = String(req.query.mine || '').toLowerCase() === 'true';

    const where = {
      ...(search
        ? {
            OR: [
              { trackingNumber: { contains: search, mode: 'insensitive' } },
              { transactionNumber: { contains: search, mode: 'insensitive' } },
              { subject: { contains: search, mode: 'insensitive' } },
              { sourceEntity: { contains: search, mode: 'insensitive' } },
              { currentAssigneeName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(ALL_STATUSES.includes(status) ? { status } : {}),
      ...(['low', 'normal', 'high', 'urgent'].includes(priority) ? { priority } : {}),
      ...(mine
        ? { currentAssigneeUserId: req.authUser.id }
        : assigneeUserId
          ? { currentAssigneeUserId: assigneeUserId }
          : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.transactionFollowUp.count({ where }),
      prisma.transactionFollowUp.findMany({
        where,
        orderBy: [
          { dueDate: { sort: 'asc', nulls: 'last' } },
          { updatedAt: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      items: rows.map(serialize),
      total,
      page,
      pageSize,
      totalPages: total ? Math.ceil(total / pageSize) : 0,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
      include: { events: { orderBy: { createdAt: 'desc' } } },
    });
    if (!row) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    res.json(serialize(row));
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const user = await resolveAssignee(input.currentAssigneeUserId);
    const createdBy = actor(req);
    const transactionDate = toDate(input.transactionDate, 'تاريخ المعاملة');
    const dueDate = toDate(input.dueDate, 'تاريخ الاستحقاق');
    const now = new Date();

    let trackingNumber = await nextTrackingNumber();
    let row;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        row = await prisma.transactionFollowUp.create({
          data: {
            trackingNumber,
            transactionNumber: input.transactionNumber,
            transactionDate,
            transactionType: input.transactionType,
            subject: input.subject,
            sourceEntity: input.sourceEntity || null,
            priority: input.priority,
            status: user ? 'assigned' : 'new',
            currentAssigneeUserId: user?.id || null,
            currentAssigneeName: user?.username || null,
            assignedAt: user ? now : null,
            requiredAction: input.requiredAction || null,
            dueDate,
            inactivityAlertDays: input.inactivityAlertDays,
            notes: input.notes || null,
            relatedModule: input.relatedModule || null,
            relatedEntityId: input.relatedEntityId || null,
            relatedEntityLabel: input.relatedEntityLabel || null,
            lastActionAt: now,
            lastActionByUserId: createdBy.id,
            lastActionByName: createdBy.name,
            createdById: createdBy.id,
            createdByName: createdBy.name,
            events: {
              create: [
                {
                  eventType: 'created',
                  toStatus: user ? 'assigned' : 'new',
                  toAssigneeUserId: user?.id || null,
                  toAssigneeName: user?.username || null,
                  actionText: 'تسجيل المعاملة في نظام المتابعة',
                  note: input.notes || null,
                  createdById: createdBy.id,
                  createdByName: createdBy.name,
                },
              ],
            },
          },
        });
        break;
      } catch (error) {
        if (error?.code !== 'P2002' || attempt === 2) throw error;
        trackingNumber = await nextTrackingNumber();
      }
    }

    if (user) {
      await createFollowUpAlert({
        alertKey: `assignment:${row.id}:${row.createdAt.toISOString()}:${user.id}`,
        transactionId: row.id,
        userId: user.id,
        kind: 'assigned',
        severity: 'info',
        title: 'تم إسناد معاملة إليك',
        message: `${row.transactionNumber} — ${row.subject}. المطلوب: ${row.requiredAction || 'مراجعة المعاملة واتخاذ الإجراء المناسب'}.`,
      });
    }

    res.status(201).json(serialize(row));
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = updateSchema.parse(req.body);
    const current = await prisma.transactionFollowUp.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (!canEditRecordMaster(req, current)) return denyRecordAccess(res);

    const updated = await prisma.transactionFollowUp.update({
      where: { id: current.id },
      data: {
        ...(input.transactionNumber !== undefined ? { transactionNumber: input.transactionNumber } : {}),
        ...(input.transactionDate !== undefined ? { transactionDate: toDate(input.transactionDate, 'تاريخ المعاملة') } : {}),
        ...(input.transactionType !== undefined ? { transactionType: input.transactionType } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.sourceEntity !== undefined ? { sourceEntity: input.sourceEntity || null } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.requiredAction !== undefined ? { requiredAction: input.requiredAction || null } : {}),
        ...(input.dueDate !== undefined ? { dueDate: toDate(input.dueDate, 'تاريخ الاستحقاق') } : {}),
        ...(input.inactivityAlertDays !== undefined ? { inactivityAlertDays: input.inactivityAlertDays } : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
        ...(input.relatedModule !== undefined ? { relatedModule: input.relatedModule || null } : {}),
        ...(input.relatedEntityId !== undefined ? { relatedEntityId: input.relatedEntityId || null } : {}),
        ...(input.relatedEntityLabel !== undefined ? { relatedEntityLabel: input.relatedEntityLabel || null } : {}),
      },
    });

    res.json(serialize(updated));
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/assign', async (req, res, next) => {
  try {
    const input = assignSchema.parse(req.body);
    const current = await prisma.transactionFollowUp.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (!canActOnRecord(req, current)) return denyRecordAccess(res);
    if (FINAL_STATUSES.includes(current.status)) {
      return res.status(409).json({ message: 'المعاملة منجزة أو مغلقة. أعد فتحها قبل إعادة الإسناد.' });
    }

    const target = await resolveAssignee(input.assigneeUserId);
    const changedBy = actor(req);
    const now = new Date();
    const eventType = current.currentAssigneeUserId ? 'transferred' : 'assigned';

    const updated = await prisma.transactionFollowUp.update({
      where: { id: current.id },
      data: {
        currentAssigneeUserId: target.id,
        currentAssigneeName: target.username,
        assignedAt: now,
        status: current.status === 'new' ? 'assigned' : current.status,
        lastActionAt: now,
        lastActionByUserId: changedBy.id,
        lastActionByName: changedBy.name,
        events: {
          create: {
            eventType,
            fromStatus: current.status,
            toStatus: current.status === 'new' ? 'assigned' : current.status,
            fromAssigneeUserId: current.currentAssigneeUserId,
            fromAssigneeName: current.currentAssigneeName,
            toAssigneeUserId: target.id,
            toAssigneeName: target.username,
            actionText: eventType === 'transferred' ? 'تحويل المعاملة إلى موظف آخر' : 'إسناد المعاملة',
            note: input.note || null,
            createdById: changedBy.id,
            createdByName: changedBy.name,
          },
        },
      },
    });

    await createFollowUpAlert({
      alertKey: `assignment:${updated.id}:${now.toISOString()}:${target.id}`,
      transactionId: updated.id,
      userId: target.id,
      kind: eventType,
      severity: 'info',
      title: eventType === 'transferred' ? 'تم تحويل معاملة إليك' : 'تم إسناد معاملة إليك',
      message: `${updated.transactionNumber} — ${updated.subject}. المطلوب: ${updated.requiredAction || 'مراجعة المعاملة واتخاذ الإجراء المناسب'}.`,
    });

    res.json(serialize(updated));
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/action', async (req, res, next) => {
  try {
    const input = actionSchema.parse(req.body);
    const current = await prisma.transactionFollowUp.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (!canActOnRecord(req, current)) return denyRecordAccess(res);

    const changedBy = actor(req);
    const now = new Date();
    const nextStatus = input.status || (current.status === 'new' || current.status === 'assigned' ? 'in_progress' : current.status);
    const completedAt = nextStatus === 'completed' ? now : nextStatus === 'closed' ? current.completedAt : null;
    const closedAt = nextStatus === 'closed' ? now : null;

    const updated = await prisma.transactionFollowUp.update({
      where: { id: current.id },
      data: {
        status: nextStatus,
        ...(input.requiredAction !== undefined ? { requiredAction: input.requiredAction || null } : {}),
        ...(input.dueDate !== undefined ? { dueDate: toDate(input.dueDate, 'تاريخ الاستحقاق') } : {}),
        lastActionAt: now,
        lastActionByUserId: changedBy.id,
        lastActionByName: changedBy.name,
        completedAt,
        closedAt,
        events: {
          create: {
            eventType: nextStatus !== current.status ? 'status_changed' : 'action_recorded',
            fromStatus: current.status,
            toStatus: nextStatus,
            fromAssigneeUserId: current.currentAssigneeUserId,
            fromAssigneeName: current.currentAssigneeName,
            toAssigneeUserId: current.currentAssigneeUserId,
            toAssigneeName: current.currentAssigneeName,
            actionText: input.actionText,
            note: input.note || null,
            createdById: changedBy.id,
            createdByName: changedBy.name,
          },
        },
      },
    });

    res.json(serialize(updated));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const current = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    await prisma.transactionFollowUp.delete({ where: { id: current.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
