import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import {
  archiveTransactionExecutiveReport,
  calculateNextTransactionReportRun,
  syncScheduledTransactionReports,
} from '../services/transactionReports.service.js';

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

const reportArchiveSchema = z.object({
  reportType: z.enum(['weekly', 'monthly', 'custom']).default('custom'),
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  assigneeUserId: nullableText(100),
});

const reportScheduleSchema = z.object({
  name: z.string().trim().min(2).max(200),
  frequency: z.enum(['weekly', 'monthly']),
  dayOfWeek: z.coerce.number().int().min(0).max(6).optional().nullable(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).optional().nullable(),
  runHour: z.coerce.number().int().min(0).max(23).default(8),
  assigneeUserId: nullableText(100),
  isActive: z.boolean().optional().default(true),
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

const dayNumberFromKey = (value) => {
  const [year, month, day] = String(value).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
};

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

router.get('/executive-inbox', async (req, res, next) => {
  try {
    const supervisor = isSupervisor(req);
    const mineRequested = String(req.query.mine || '').toLowerCase() === 'true';
    const mine = !supervisor || mineRequested;
    const baseWhere = mine ? { currentAssigneeUserId: req.authUser.id } : {};
    const now = new Date();
    const todayKey = saudiDayKey(now);
    const todayNumber = dayNumberFromKey(todayKey);

    const rows = await prisma.transactionFollowUp.findMany({
      where: { ...baseWhere, status: { in: OPEN_STATUSES } },
      select: {
        id: true,
        trackingNumber: true,
        transactionNumber: true,
        transactionDate: true,
        subject: true,
        priority: true,
        status: true,
        currentAssigneeUserId: true,
        currentAssigneeName: true,
        dueDate: true,
        assignedAt: true,
        lastActionAt: true,
        inactivityAlertDays: true,
        requiredAction: true,
        createdAt: true,
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { createdAt: 'asc' }],
    });

    const counters = {
      totalOpen: rows.length,
      attention: 0,
      overdue: 0,
      dueToday: 0,
      unassigned: 0,
      inactive: 0,
      needsFollowUp: 0,
      urgent: 0,
      staleWaiting: 0,
    };

    const employeeMap = new Map();

    const attentionItems = rows.flatMap((row) => {
      const indicator = computeIndicator(row);
      const dueKey = row.dueDate ? saudiDayKey(new Date(row.dueDate)) : null;
      const dueDayNumber = dueKey ? dayNumberFromKey(dueKey) : null;
      const daysOverdue = dueDayNumber == null ? 0 : Math.max(0, todayNumber - dueDayNumber);
      const isDueToday = dueKey === todayKey;
      const isUnassigned = !row.currentAssigneeUserId;
      const isInactive = indicator.indicator === 'inactive';
      const isNeedsFollowUp = row.status === 'needs_follow_up';
      const isUrgent = row.priority === 'urgent';
      const isStaleWaiting = row.status === 'waiting_response' && indicator.daysWithoutAction >= 5;
      const isOverdue = daysOverdue > 0;

      if (isOverdue) counters.overdue += 1;
      if (isDueToday) counters.dueToday += 1;
      if (isUnassigned) counters.unassigned += 1;
      if (isInactive) counters.inactive += 1;
      if (isNeedsFollowUp) counters.needsFollowUp += 1;
      if (isUrgent) counters.urgent += 1;
      if (isStaleWaiting) counters.staleWaiting += 1;

      const reasons = [];
      let score = 0;

      if (isOverdue) {
        reasons.push(`متأخرة ${daysOverdue} يوم`);
        score += 100 + Math.min(daysOverdue * 4, 40);
      }
      if (isUnassigned) {
        reasons.push('غير مسندة');
        score += 95;
      }
      if (isNeedsFollowUp) {
        reasons.push('تحتاج إجراء');
        score += 90;
      }
      if (isUrgent) {
        reasons.push('أولوية عاجلة');
        score += 85;
      }
      if (isDueToday) {
        reasons.push('مستحقة اليوم');
        score += 80;
      }
      if (isInactive) {
        reasons.push(`دون إجراء منذ ${indicator.daysWithoutAction} يوم`);
        score += 70 + Math.min(indicator.daysWithoutAction, 20);
      }
      if (isStaleWaiting) {
        reasons.push(`بانتظار رد منذ ${indicator.daysWithoutAction} يوم`);
        score += 60;
      }

      const needsAttention = reasons.length > 0;
      if (needsAttention) counters.attention += 1;

      if (row.currentAssigneeUserId) {
        const employee = employeeMap.get(row.currentAssigneeUserId) || {
          userId: row.currentAssigneeUserId,
          username: row.currentAssigneeName || 'مستخدم',
          open: 0,
          overdue: 0,
          needsAction: 0,
          urgent: 0,
        };
        employee.open += 1;
        if (isOverdue) employee.overdue += 1;
        if (needsAttention) employee.needsAction += 1;
        if (isUrgent) employee.urgent += 1;
        employeeMap.set(employee.userId, employee);
      }

      if (!needsAttention) return [];

      return [{
        id: row.id,
        trackingNumber: row.trackingNumber,
        transactionNumber: row.transactionNumber,
        transactionDate: row.transactionDate,
        subject: row.subject,
        priority: row.priority,
        status: row.status,
        currentAssigneeUserId: row.currentAssigneeUserId,
        currentAssigneeName: row.currentAssigneeName,
        dueDate: row.dueDate,
        requiredAction: row.requiredAction,
        lastActionAt: row.lastActionAt,
        daysWithoutAction: indicator.daysWithoutAction,
        daysOverdue,
        reasons,
        primaryReason: reasons[0],
        score,
      }];
    })
      .sort((a, b) =>
        (b.score - a.score) ||
        ((a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER) -
          (b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER))
      );

    const employeesRaw = [...employeeMap.values()];
    const averageOpen = employeesRaw.length
      ? employeesRaw.reduce((sum, item) => sum + item.open, 0) / employeesRaw.length
      : 0;
    const highLoadThreshold = Math.max(3, Math.ceil(averageOpen * 1.4));

    const employeeLoad = supervisor && !mine
      ? employeesRaw
        .map((item) => ({
          ...item,
          highLoad: item.open >= highLoadThreshold || item.overdue >= 2,
          riskScore: item.overdue * 4 + item.needsAction * 2 + item.urgent * 2 + item.open,
        }))
        .sort((a, b) => (b.riskScore - a.riskScore) || (b.open - a.open))
        .slice(0, 8)
      : [];

    res.json({
      generatedAt: now,
      scope: mine ? 'mine' : 'all',
      counters,
      attentionItems: attentionItems.slice(0, 12),
      employeeLoad,
      highLoadThreshold,
    });
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

router.get('/reports/archives', async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(10, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));
    const supervisor = isSupervisor(req);
    const requestedAssignee = String(req.query.assigneeUserId || '').trim();
    const where = supervisor
      ? (requestedAssignee ? { assigneeUserId: requestedAssignee } : {})
      : { assigneeUserId: req.authUser.id };

    const [total, items] = await Promise.all([
      prisma.transactionFollowUpReportArchive.count({ where }),
      prisma.transactionFollowUpReportArchive.findMany({
        where,
        select: {
          id: true,
          reportType: true,
          periodFrom: true,
          periodTo: true,
          assigneeUserId: true,
          assigneeName: true,
          scopeMine: true,
          source: true,
          summary: true,
          scheduleId: true,
          generatedById: true,
          generatedByName: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      items,
      total,
      page,
      pageSize,
      totalPages: total ? Math.ceil(total / pageSize) : 0,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/reports/archives/compare', async (req, res, next) => {
  try {
    const leftId = String(req.query.leftId || '').trim();
    const rightId = String(req.query.rightId || '').trim();
    if (!leftId || !rightId) {
      return res.status(400).json({ message: 'حدد تقريرين للمقارنة' });
    }

    const rows = await prisma.transactionFollowUpReportArchive.findMany({
      where: { id: { in: [leftId, rightId] } },
    });
    if (rows.length !== 2) return res.status(404).json({ message: 'تعذر العثور على أحد التقريرين' });

    const supervisor = isSupervisor(req);
    if (!supervisor && rows.some((row) => row.assigneeUserId !== req.authUser.id)) {
      return res.status(403).json({ message: 'لا يمكنك مقارنة تقرير خارج نطاق معاملاتك' });
    }

    const left = rows.find((row) => row.id === leftId);
    const right = rows.find((row) => row.id === rightId);
    const leftSummary = left?.summary || {};
    const rightSummary = right?.summary || {};
    const numericKeys = [
      'totalIncluded',
      'open',
      'completed',
      'waiting',
      'needsFollowUp',
      'overdueSnapshot',
      'onTimeRate',
      'avgCompletionDays',
      'avgFirstActionHours',
    ];

    const delta = {};
    numericKeys.forEach((key) => {
      const leftValue = Number(leftSummary?.[key]);
      const rightValue = Number(rightSummary?.[key]);
      delta[key] = Number.isFinite(leftValue) && Number.isFinite(rightValue)
        ? Number((rightValue - leftValue).toFixed(1))
        : null;
    });

    res.json({ left, right, delta });
  } catch (error) {
    next(error);
  }
});

router.get('/reports/archives/:id', async (req, res, next) => {
  try {
    const row = await prisma.transactionFollowUpReportArchive.findUnique({
      where: { id: req.params.id },
    });
    if (!row) return res.status(404).json({ message: 'التقرير المؤرشف غير موجود' });
    if (!isSupervisor(req) && row.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'لا يمكنك عرض هذا التقرير' });
    }
    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.post('/reports/archives', async (req, res, next) => {
  try {
    const input = reportArchiveSchema.parse(req.body);
    const supervisor = isSupervisor(req);
    const requestedAssignee = supervisor ? input.assigneeUserId || null : req.authUser.id;
    const assignee = requestedAssignee ? await resolveAssignee(requestedAssignee) : null;
    const createdBy = actor(req);

    const from = toDate(input.from, 'بداية فترة التقرير');
    const to = toDate(input.to, 'نهاية فترة التقرير');
    if (from.getTime() > to.getTime()) {
      return res.status(400).json({ message: 'بداية فترة التقرير يجب أن تسبق نهايتها' });
    }

    const archive = await archiveTransactionExecutiveReport({
      reportType: input.reportType,
      from,
      to,
      assigneeUserId: assignee?.id || null,
      assigneeName: assignee?.username || null,
      scopeMine: !supervisor || Boolean(assignee),
      source: 'manual',
      generatedById: createdBy.id,
      generatedByName: createdBy.name,
    });

    res.status(201).json(archive);
  } catch (error) {
    next(error);
  }
});

router.delete('/reports/archives/:id', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'حذف التقارير المؤرشفة متاح للمستخدم الإشرافي فقط' });
    }
    await prisma.transactionFollowUpReportArchive.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get('/reports/schedules', async (req, res, next) => {
  try {
    const supervisor = isSupervisor(req);
    const where = supervisor ? {} : { assigneeUserId: req.authUser.id };
    const rows = await prisma.transactionFollowUpReportSchedule.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/reports/schedules', async (req, res, next) => {
  try {
    const input = reportScheduleSchema.parse(req.body);
    const supervisor = isSupervisor(req);
    const requestedAssignee = supervisor ? input.assigneeUserId || null : req.authUser.id;
    const assignee = requestedAssignee ? await resolveAssignee(requestedAssignee) : null;
    const createdBy = actor(req);

    const draft = {
      frequency: input.frequency,
      dayOfWeek: input.frequency === 'weekly' ? (input.dayOfWeek ?? 0) : null,
      dayOfMonth: input.frequency === 'monthly' ? (input.dayOfMonth ?? 1) : null,
      runHour: input.runHour,
    };

    const row = await prisma.transactionFollowUpReportSchedule.create({
      data: {
        name: input.name,
        frequency: input.frequency,
        dayOfWeek: draft.dayOfWeek,
        dayOfMonth: draft.dayOfMonth,
        runHour: input.runHour,
        assigneeUserId: assignee?.id || null,
        assigneeName: assignee?.username || null,
        isActive: input.isActive,
        nextRunAt: input.isActive ? calculateNextTransactionReportRun(draft) : null,
        createdById: createdBy.id,
        createdByName: createdBy.name,
      },
    });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.patch('/reports/schedules/:id', async (req, res, next) => {
  try {
    const input = reportScheduleSchema.partial().parse(req.body);
    const current = await prisma.transactionFollowUpReportSchedule.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'جدولة التقرير غير موجودة' });

    const supervisor = isSupervisor(req);
    if (!supervisor && current.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'لا يمكنك تعديل هذه الجدولة' });
    }

    const nextFrequency = input.frequency || current.frequency;
    const requestedAssignee = supervisor
      ? (input.assigneeUserId !== undefined ? input.assigneeUserId || null : current.assigneeUserId)
      : req.authUser.id;
    const assignee = requestedAssignee ? await resolveAssignee(requestedAssignee) : null;
    const isActive = input.isActive ?? current.isActive;
    const nextSchedule = {
      frequency: nextFrequency,
      dayOfWeek: nextFrequency === 'weekly'
        ? (input.dayOfWeek ?? current.dayOfWeek ?? 0)
        : null,
      dayOfMonth: nextFrequency === 'monthly'
        ? (input.dayOfMonth ?? current.dayOfMonth ?? 1)
        : null,
      runHour: input.runHour ?? current.runHour,
    };

    const row = await prisma.transactionFollowUpReportSchedule.update({
      where: { id: current.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        frequency: nextFrequency,
        dayOfWeek: nextSchedule.dayOfWeek,
        dayOfMonth: nextSchedule.dayOfMonth,
        runHour: nextSchedule.runHour,
        assigneeUserId: assignee?.id || null,
        assigneeName: assignee?.username || null,
        isActive,
        nextRunAt: isActive ? calculateNextTransactionReportRun(nextSchedule) : null,
      },
    });
    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.post('/reports/schedules/:id/run', async (req, res, next) => {
  try {
    const schedule = await prisma.transactionFollowUpReportSchedule.findUnique({
      where: { id: req.params.id },
    });
    if (!schedule) return res.status(404).json({ message: 'جدولة التقرير غير موجودة' });
    if (!isSupervisor(req) && schedule.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'لا يمكنك تشغيل هذه الجدولة' });
    }

    await prisma.transactionFollowUpReportSchedule.update({
      where: { id: schedule.id },
      data: { nextRunAt: new Date() },
    });
    const result = await syncScheduledTransactionReports();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/reports/schedules/:id', async (req, res, next) => {
  try {
    const schedule = await prisma.transactionFollowUpReportSchedule.findUnique({
      where: { id: req.params.id },
    });
    if (!schedule) return res.status(404).json({ message: 'جدولة التقرير غير موجودة' });
    if (!isSupervisor(req) && schedule.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'لا يمكنك حذف هذه الجدولة' });
    }
    await prisma.transactionFollowUpReportSchedule.delete({ where: { id: schedule.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get('/reports/executive', async (req, res, next) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const from = req.query.from
      ? toDate(String(req.query.from), 'بداية فترة التقرير')
      : defaultFrom;
    const toRaw = req.query.to
      ? toDate(String(req.query.to), 'نهاية فترة التقرير')
      : defaultTo;
    const to = new Date(toRaw);
    to.setHours(23, 59, 59, 999);

    if (from.getTime() > to.getTime()) {
      return res.status(400).json({ message: 'بداية فترة التقرير يجب أن تسبق نهايتها' });
    }

    const requestedAssignee = String(req.query.assigneeUserId || '').trim();
    const mine = String(req.query.mine || '').toLowerCase() === 'true';
    const supervisor = isSupervisor(req);
    const scopeAssigneeId = supervisor
      ? (mine ? req.authUser.id : requestedAssignee || null)
      : req.authUser.id;

    const assigneeScope = scopeAssigneeId ? { currentAssigneeUserId: scopeAssigneeId } : {};
    const activityWhere = {
      ...assigneeScope,
      OR: [
        { transactionDate: { gte: from, lte: to } },
        { completedAt: { gte: from, lte: to } },
        { closedAt: { gte: from, lte: to } },
      ],
    };

    const [rows, overdueSnapshot] = await Promise.all([
      prisma.transactionFollowUp.findMany({
        where: activityWhere,
        select: {
          id: true,
          trackingNumber: true,
          transactionNumber: true,
          transactionDate: true,
          transactionType: true,
          subject: true,
          sourceEntity: true,
          priority: true,
          status: true,
          currentAssigneeUserId: true,
          currentAssigneeName: true,
          assignedAt: true,
          requiredAction: true,
          dueDate: true,
          inactivityAlertDays: true,
          lastActionAt: true,
          completedAt: true,
          closedAt: true,
          createdAt: true,
          events: {
            where: { eventType: { in: ['action_recorded', 'status_changed'] } },
            select: { createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.transactionFollowUp.findMany({
        where: {
          ...assigneeScope,
          status: { in: OPEN_STATUSES },
          dueDate: { lte: to },
        },
        select: {
          id: true,
          trackingNumber: true,
          transactionNumber: true,
          subject: true,
          priority: true,
          status: true,
          currentAssigneeName: true,
          dueDate: true,
          lastActionAt: true,
          assignedAt: true,
          inactivityAlertDays: true,
          createdAt: true,
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    const finishedRows = rows.filter((row) => FINAL_STATUSES.includes(row.status) && (row.completedAt || row.closedAt));
    const completedWithDue = finishedRows.filter((row) => row.dueDate);
    const onTimeCompleted = completedWithDue.filter((row) => {
      const finishedAt = row.completedAt || row.closedAt;
      return finishedAt && new Date(finishedAt).getTime() <= new Date(row.dueDate).getTime();
    });

    const avg = (values) => values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    const round = (value, digits = 1) => value == null ? null : Number(value.toFixed(digits));

    const completionDays = finishedRows
      .map((row) => {
        const finishedAt = row.completedAt || row.closedAt;
        return finishedAt
          ? Math.max(0, (new Date(finishedAt).getTime() - new Date(row.createdAt).getTime()) / 86400000)
          : null;
      })
      .filter((value) => value != null);

    const firstActionHours = rows.flatMap((row) => {
      if (!row.assignedAt || !row.events?.length) return [];
      const assignedAt = new Date(row.assignedAt).getTime();
      const first = row.events.find((event) => new Date(event.createdAt).getTime() >= assignedAt);
      return first
        ? [Math.max(0, (new Date(first.createdAt).getTime() - assignedAt) / 3600000)]
        : [];
    });

    const statusCounts = ALL_STATUSES.reduce((acc, status) => {
      acc[status] = rows.filter((row) => row.status === status).length;
      return acc;
    }, {});

    const employeeMap = new Map();
    rows.forEach((row) => {
      const key = row.currentAssigneeUserId || '__unassigned__';
      const current = employeeMap.get(key) || {
        userId: row.currentAssigneeUserId || null,
        username: row.currentAssigneeName || 'غير مسندة',
        total: 0,
        open: 0,
        completed: 0,
        overdue: 0,
      };
      current.total += 1;
      if (OPEN_STATUSES.includes(row.status)) current.open += 1;
      if (FINAL_STATUSES.includes(row.status)) current.completed += 1;
      if (row.dueDate && OPEN_STATUSES.includes(row.status) && new Date(row.dueDate).getTime() < to.getTime()) {
        current.overdue += 1;
      }
      employeeMap.set(key, current);
    });

    const transactions = rows.map((row) => {
      const indicator = computeIndicator(row);
      return {
        id: row.id,
        trackingNumber: row.trackingNumber,
        transactionNumber: row.transactionNumber,
        transactionDate: row.transactionDate,
        transactionType: row.transactionType,
        subject: row.subject,
        sourceEntity: row.sourceEntity,
        priority: row.priority,
        status: row.status,
        currentAssigneeName: row.currentAssigneeName,
        requiredAction: row.requiredAction,
        dueDate: row.dueDate,
        completedAt: row.completedAt,
        closedAt: row.closedAt,
        indicator: indicator.indicator,
        indicatorLabel: indicator.indicatorLabel,
      };
    });

    const overdueRows = overdueSnapshot.map((row) => ({
      id: row.id,
      trackingNumber: row.trackingNumber,
      transactionNumber: row.transactionNumber,
      subject: row.subject,
      priority: row.priority,
      status: row.status,
      currentAssigneeName: row.currentAssigneeName,
      dueDate: row.dueDate,
      overdueDays: Math.max(
        0,
        Math.floor((to.getTime() - new Date(row.dueDate).getTime()) / 86400000),
      ),
      indicatorLabel: computeIndicator(row).indicatorLabel,
    }));

    res.json({
      generatedAt: now,
      period: { from, to },
      scope: {
        mine: !supervisor || mine,
        assigneeUserId: scopeAssigneeId,
      },
      summary: {
        totalIncluded: rows.length,
        open: rows.filter((row) => OPEN_STATUSES.includes(row.status)).length,
        completed: finishedRows.length,
        waiting: rows.filter((row) => row.status === 'waiting_response').length,
        needsFollowUp: rows.filter((row) => ['needs_follow_up'].includes(row.status)).length,
        overdueSnapshot: overdueRows.length,
        onTimeRate: completedWithDue.length
          ? round((onTimeCompleted.length / completedWithDue.length) * 100, 1)
          : null,
        avgCompletionDays: round(avg(completionDays), 1),
        avgFirstActionHours: round(avg(firstActionHours), 1),
      },
      statusCounts,
      employees: [...employeeMap.values()].sort((a, b) =>
        (b.overdue - a.overdue) || (b.open - a.open) || (b.total - a.total)
      ),
      transactions,
      overdueSnapshot: overdueRows.slice(0, 100),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics', async (req, res, next) => {
  try {
    const mine = String(req.query.mine || '').toLowerCase() === 'true';
    const periodDaysRaw = String(req.query.periodDays || '90');
    const periodDays = periodDaysRaw === 'all'
      ? null
      : Math.min(730, Math.max(7, Number.parseInt(periodDaysRaw, 10) || 90));
    const from = periodDays ? new Date(Date.now() - periodDays * 86400000) : null;
    const scope = mine ? { currentAssigneeUserId: req.authUser.id } : {};
    const periodWhere = { ...scope, ...(from ? { createdAt: { gte: from } } : {}) };
    const now = new Date();

    const [periodRows, openRows, assigneeUsers] = await Promise.all([
      prisma.transactionFollowUp.findMany({
        where: periodWhere,
        select: {
          id: true,
          trackingNumber: true,
          transactionNumber: true,
          subject: true,
          status: true,
          priority: true,
          currentAssigneeUserId: true,
          currentAssigneeName: true,
          assignedAt: true,
          dueDate: true,
          completedAt: true,
          closedAt: true,
          createdAt: true,
          events: {
            where: { eventType: { in: ['action_recorded', 'status_changed'] } },
            select: { createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      prisma.transactionFollowUp.findMany({
        where: { ...scope, status: { in: OPEN_STATUSES } },
        select: {
          id: true,
          trackingNumber: true,
          transactionNumber: true,
          subject: true,
          status: true,
          priority: true,
          currentAssigneeUserId: true,
          currentAssigneeName: true,
          dueDate: true,
          assignedAt: true,
          lastActionAt: true,
          inactivityAlertDays: true,
          createdAt: true,
        },
      }),
      prisma.appUser.findMany({
        where: {
          isActive: true,
          OR: [
            { role: 'admin' },
            { permissions: { some: { module: 'transaction_follow_up', canView: true } } },
          ],
        },
        select: { id: true, username: true },
        orderBy: { username: 'asc' },
      }),
    ]);

    const completedRows = periodRows.filter((row) => FINAL_STATUSES.includes(row.status) && (row.completedAt || row.closedAt));
    const completedWithDue = completedRows.filter((row) => row.dueDate);
    const onTimeRows = completedWithDue.filter((row) => {
      const finishedAt = row.completedAt || row.closedAt;
      return finishedAt && new Date(finishedAt).getTime() <= new Date(row.dueDate).getTime();
    });

    const avg = (values) => values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    const round = (value, digits = 1) => value == null
      ? null
      : Number(value.toFixed(digits));

    const completionDurationsDays = completedRows
      .map((row) => {
        const finishedAt = row.completedAt || row.closedAt;
        if (!finishedAt) return null;
        return Math.max(0, (new Date(finishedAt).getTime() - new Date(row.createdAt).getTime()) / 86400000);
      })
      .filter((value) => value != null);

    const firstActionSamples = periodRows.flatMap((row) => {
      if (!row.assignedAt || !row.events?.length) return [];
      const assignedAt = new Date(row.assignedAt).getTime();
      const first = row.events.find((event) => new Date(event.createdAt).getTime() >= assignedAt);
      if (!first) return [];
      return [Math.max(0, (new Date(first.createdAt).getTime() - assignedAt) / 3600000)];
    });

    const overdueOpenRows = openRows.filter((row) => row.dueDate && new Date(row.dueDate).getTime() < now.getTime());
    const activeWithoutAction = openRows.filter((row) => {
      const indicator = computeIndicator(row);
      return ['action_required', 'inactive'].includes(indicator.indicator);
    });

    const ageBuckets = {
      upTo2Days: 0,
      from3To7Days: 0,
      from8To14Days: 0,
      over14Days: 0,
    };
    openRows.forEach((row) => {
      const ageDays = Math.max(0, Math.floor((now.getTime() - new Date(row.createdAt).getTime()) / 86400000));
      if (ageDays <= 2) ageBuckets.upTo2Days += 1;
      else if (ageDays <= 7) ageBuckets.from3To7Days += 1;
      else if (ageDays <= 14) ageBuckets.from8To14Days += 1;
      else ageBuckets.over14Days += 1;
    });

    const userMap = new Map(assigneeUsers.map((user) => [user.id, {
      userId: user.id,
      username: user.username,
      open: 0,
      overdue: 0,
      completed: 0,
      completedOnTime: 0,
      completedWithDue: 0,
      completionDays: [],
      firstActionHours: [],
    }]));

    for (const row of openRows) {
      if (!row.currentAssigneeUserId) continue;
      const metric = userMap.get(row.currentAssigneeUserId) || {
        userId: row.currentAssigneeUserId,
        username: row.currentAssigneeName || 'مستخدم',
        open: 0,
        overdue: 0,
        completed: 0,
        completedOnTime: 0,
        completedWithDue: 0,
        completionDays: [],
        firstActionHours: [],
      };
      metric.open += 1;
      if (row.dueDate && new Date(row.dueDate).getTime() < now.getTime()) metric.overdue += 1;
      userMap.set(metric.userId, metric);
    }

    for (const row of completedRows) {
      if (!row.currentAssigneeUserId) continue;
      const metric = userMap.get(row.currentAssigneeUserId) || {
        userId: row.currentAssigneeUserId,
        username: row.currentAssigneeName || 'مستخدم',
        open: 0,
        overdue: 0,
        completed: 0,
        completedOnTime: 0,
        completedWithDue: 0,
        completionDays: [],
        firstActionHours: [],
      };
      metric.completed += 1;

      const finishedAt = row.completedAt || row.closedAt;
      if (finishedAt) {
        metric.completionDays.push(Math.max(0, (new Date(finishedAt).getTime() - new Date(row.createdAt).getTime()) / 86400000));
      }
      if (row.dueDate && finishedAt) {
        metric.completedWithDue += 1;
        if (new Date(finishedAt).getTime() <= new Date(row.dueDate).getTime()) metric.completedOnTime += 1;
      }
      if (row.assignedAt && row.events?.length) {
        const assignedAt = new Date(row.assignedAt).getTime();
        const first = row.events.find((event) => new Date(event.createdAt).getTime() >= assignedAt);
        if (first) metric.firstActionHours.push(Math.max(0, (new Date(first.createdAt).getTime() - assignedAt) / 3600000));
      }
      userMap.set(metric.userId, metric);
    }

    const employees = [...userMap.values()]
      .filter((item) => item.open || item.completed)
      .map((item) => ({
        userId: item.userId,
        username: item.username,
        open: item.open,
        overdue: item.overdue,
        completed: item.completed,
        onTimeRate: item.completedWithDue
          ? round((item.completedOnTime / item.completedWithDue) * 100, 1)
          : null,
        avgCompletionDays: round(avg(item.completionDays), 1),
        avgFirstActionHours: round(avg(item.firstActionHours), 1),
      }))
      .sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open) || (b.completed - a.completed));

    const oldestOverdue = overdueOpenRows
      .map((row) => ({
        id: row.id,
        trackingNumber: row.trackingNumber,
        transactionNumber: row.transactionNumber,
        subject: row.subject,
        assigneeName: row.currentAssigneeName,
        dueDate: row.dueDate,
        overdueDays: Math.max(1, Math.floor((now.getTime() - new Date(row.dueDate).getTime()) / 86400000)),
        priority: row.priority,
      }))
      .sort((a, b) => b.overdueDays - a.overdueDays)
      .slice(0, 10);

    res.json({
      periodDays,
      generatedAt: now,
      summary: {
        tracked: periodRows.length,
        open: openRows.length,
        completed: completedRows.length,
        overdueOpen: overdueOpenRows.length,
        needsAction: activeWithoutAction.length,
        onTimeRate: completedWithDue.length
          ? round((onTimeRows.length / completedWithDue.length) * 100, 1)
          : null,
        avgCompletionDays: round(avg(completionDurationsDays), 1),
        avgFirstActionHours: round(avg(firstActionSamples), 1),
      },
      ageBuckets,
      employees,
      oldestOverdue,
    });
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
