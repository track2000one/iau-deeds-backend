import { prisma } from '../prisma.js';

const OPEN_STATUSES = ['new', 'assigned', 'in_progress', 'waiting_response', 'needs_follow_up'];
const FINAL_STATUSES = ['completed', 'closed'];
const ALL_STATUSES = [...OPEN_STATUSES, ...FINAL_STATUSES];
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

const round = (value, digits = 1) =>
  value == null ? null : Number(value.toFixed(digits));

const avg = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const riyadhParts = (date = new Date()) => {
  const shifted = new Date(date.getTime() + RIYADH_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
  };
};

const riyadhLocalToUtc = (year, month, day, hour = 8) =>
  new Date(Date.UTC(year, month, day, hour - 3, 0, 0, 0));

const endOfSaudiDayUtc = (date) => {
  const parts = riyadhParts(date);
  const nextSaudiMidnightUtc = Date.UTC(parts.year, parts.month, parts.day + 1, -3, 0, 0, 0);
  return new Date(nextSaudiMidnightUtc - 1);
};

const startOfSaudiDayUtc = (date) => {
  const parts = riyadhParts(date);
  return riyadhLocalToUtc(parts.year, parts.month, parts.day, 0);
};

const reportTemplateSnapshot = (template) => {
  if (!template) return null;
  return {
    id: template.id,
    name: template.name,
    scope: template.scope,
    reportMode: template.reportMode,
    customFrom: template.customFrom ? new Date(template.customFrom).toISOString() : null,
    customTo: template.customTo ? new Date(template.customTo).toISOString() : null,
    assigneeUserId: template.assigneeUserId,
    orientation: template.orientation,
    options: template.options,
    accessMode: template.accessMode,
    isDefault: template.isDefault,
    updatedAt: template.updatedAt ? new Date(template.updatedAt).toISOString() : null,
  };
};

const flexibleReportCategoryForStatus = (status) => {
  if (status === 'completed') return 'completed';
  if (status === 'waiting_response') return 'waiting_response';
  if (status === 'needs_follow_up') return 'needs_follow_up';
  return null;
};

const buildFlexibleReportSummary = (report, templateSnapshot) => {
  const options =
    templateSnapshot?.options && typeof templateSnapshot.options === 'object'
      ? templateSnapshot.options
      : null;
  if (!options) return report.summary;

  const transactionById = new Map(report.transactions.map((row) => [row.id, row]));
  const overdueIds = new Set(report.overdueSnapshot.map((row) => row.id));

  const overdueRows = report.overdueSnapshot.map((row) => {
    const source = transactionById.get(row.id);
    return {
      id: row.id,
      transactionNumber: row.transactionNumber,
      subject: row.subject,
      organizationalUnit: source?.organizationalUnit || null,
      currentAssigneeName: row.currentAssigneeName || source?.currentAssigneeName || null,
      requiredAction: source?.requiredAction || null,
      priority: row.priority,
      category: 'overdue',
    };
  });

  const statusRows = report.transactions
    .filter((row) => !overdueIds.has(row.id))
    .map((row) => {
      const category = flexibleReportCategoryForStatus(row.status);
      if (!category) return null;
      return {
        id: row.id,
        transactionNumber: row.transactionNumber,
        subject: row.subject,
        organizationalUnit: row.organizationalUnit || null,
        currentAssigneeName: row.currentAssigneeName || null,
        requiredAction: row.requiredAction || null,
        priority: row.priority,
        category,
      };
    })
    .filter(Boolean);

  const categories = new Set(
    Array.isArray(options.categories) && options.categories.length
      ? options.categories
      : ['completed', 'overdue', 'waiting_response', 'needs_follow_up'],
  );
  const excludedIds = new Set(
    Array.isArray(options.excludedIds)
      ? options.excludedIds.map((value) => String(value))
      : [],
  );
  const search = String(options.search || '').trim().toLocaleLowerCase('ar');

  const rows = [...overdueRows, ...statusRows].filter((row) => {
    if (excludedIds.has(row.id)) return false;
    if (!categories.has(row.category)) return false;
    if (options.priority && row.priority !== options.priority) return false;
    if (
      options.organizationalUnit
      && row.organizationalUnit !== options.organizationalUnit
    ) {
      return false;
    }
    if (search) {
      const haystack = [
        row.transactionNumber,
        row.subject,
        row.currentAssigneeName || '',
        row.requiredAction || '',
        row.organizationalUnit || '',
        row.category,
      ]
        .join(' ')
        .toLocaleLowerCase('ar');
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const completed = rows.filter((row) => row.category === 'completed').length;
  const overdueSnapshot = rows.filter((row) => row.category === 'overdue').length;
  const waiting = rows.filter((row) => row.category === 'waiting_response').length;
  const needsFollowUp = rows.filter((row) => row.category === 'needs_follow_up').length;

  return {
    ...report.summary,
    totalIncluded: rows.length,
    open: overdueSnapshot + waiting + needsFollowUp,
    completed,
    waiting,
    needsFollowUp,
    overdueSnapshot,
  };
};

const indicatorForReport = (row, referenceDate = new Date()) => {
  if (FINAL_STATUSES.includes(row.status)) {
    return {
      indicator: 'completed',
      indicatorLabel: row.status === 'closed' ? 'مغلقة' : 'منجزة',
    };
  }

  if (!row.currentAssigneeUserId) {
    return { indicator: 'unassigned', indicatorLabel: 'تحتاج إسناد' };
  }

  if (row.dueDate && new Date(row.dueDate).getTime() < referenceDate.getTime()) {
    const days = Math.max(
      1,
      Math.floor((referenceDate.getTime() - new Date(row.dueDate).getTime()) / 86400000),
    );
    return { indicator: 'overdue', indicatorLabel: `متأخرة ${days} يوم` };
  }

  if (row.status === 'needs_follow_up') {
    return { indicator: 'action_required', indicatorLabel: 'تحتاج إجراء' };
  }

  if (row.status === 'waiting_response') {
    return { indicator: 'waiting', indicatorLabel: 'بانتظار رد' };
  }

  return { indicator: 'on_track', indicatorLabel: 'ضمن المتابعة' };
};

export const buildTransactionExecutiveReport = async ({
  from,
  to,
  organizationalUnit = null,
  assigneeUserId = null,
  scopeMine = false,
  generatedAt = new Date(),
}) => {
  const fromDate = startOfSaudiDayUtc(from);
  const toDate = endOfSaudiDayUtc(to);
  const assigneeScope = assigneeUserId ? { currentAssigneeUserId: assigneeUserId } : {};
  const organizationalUnitScope = organizationalUnit ? { organizationalUnit } : {};

  const activityWhere = {
    ...assigneeScope,
    ...organizationalUnitScope,
    OR: [
      { transactionDate: { gte: fromDate, lte: toDate } },
      { completedAt: { gte: fromDate, lte: toDate } },
      { closedAt: { gte: fromDate, lte: toDate } },
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
        organizationalUnit: true,
        subject: true,
        sourceEntity: true,
        priority: true,
        status: true,
        currentAssigneeUserId: true,
        currentAssigneeName: true,
        assignedAt: true,
        requiredAction: true,
        dueDate: true,
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
        ...organizationalUnitScope,
        status: { in: OPEN_STATUSES },
        dueDate: { lte: toDate },
      },
      select: {
        id: true,
        trackingNumber: true,
        transactionNumber: true,
        subject: true,
        priority: true,
        status: true,
        currentAssigneeUserId: true,
        currentAssigneeName: true,
        dueDate: true,
        createdAt: true,
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);

  const finishedRows = rows.filter(
    (row) => FINAL_STATUSES.includes(row.status) && (row.completedAt || row.closedAt),
  );
  const completedWithDue = finishedRows.filter((row) => row.dueDate);
  const onTimeCompleted = completedWithDue.filter((row) => {
    const finishedAt = row.completedAt || row.closedAt;
    return finishedAt && new Date(finishedAt).getTime() <= new Date(row.dueDate).getTime();
  });

  const completionDays = finishedRows
    .map((row) => {
      const finishedAt = row.completedAt || row.closedAt;
      return finishedAt
        ? Math.max(
            0,
            (new Date(finishedAt).getTime() - new Date(row.createdAt).getTime()) / 86400000,
          )
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
    if (
      row.dueDate &&
      OPEN_STATUSES.includes(row.status) &&
      new Date(row.dueDate).getTime() < toDate.getTime()
    ) {
      current.overdue += 1;
    }
    employeeMap.set(key, current);
  });

  const transactions = rows.map((row) => {
    const indicator = indicatorForReport(row, toDate);
    return {
      id: row.id,
      trackingNumber: row.trackingNumber,
      transactionNumber: row.transactionNumber,
      transactionDate: row.transactionDate,
      transactionType: row.transactionType,
      organizationalUnit: row.organizationalUnit,
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
      Math.floor((toDate.getTime() - new Date(row.dueDate).getTime()) / 86400000),
    ),
    indicatorLabel: indicatorForReport(row, toDate).indicatorLabel,
  }));

  return {
    generatedAt,
    period: { from: fromDate, to: toDate },
    scope: {
      mine: scopeMine,
      assigneeUserId,
      organizationalUnit,
    },
    summary: {
      totalIncluded: rows.length,
      open: rows.filter((row) => OPEN_STATUSES.includes(row.status)).length,
      completed: finishedRows.length,
      waiting: rows.filter((row) => row.status === 'waiting_response').length,
      needsFollowUp: rows.filter((row) => row.status === 'needs_follow_up').length,
      overdueSnapshot: overdueRows.length,
      onTimeRate: completedWithDue.length
        ? round((onTimeCompleted.length / completedWithDue.length) * 100, 1)
        : null,
      avgCompletionDays: round(avg(completionDays), 1),
      avgFirstActionHours: round(avg(firstActionHours), 1),
    },
    statusCounts,
    employees: [...employeeMap.values()].sort(
      (a, b) => b.overdue - a.overdue || b.open - a.open || b.total - a.total,
    ),
    transactions,
    overdueSnapshot: overdueRows.slice(0, 100),
  };
};

export const calculateNextTransactionReportRun = (schedule, now = new Date()) => {
  const parts = riyadhParts(now);
  const hour = Math.min(23, Math.max(0, Number(schedule.runHour ?? 8)));

  if (schedule.frequency === 'monthly') {
    const day = Math.min(28, Math.max(1, Number(schedule.dayOfMonth || 1)));
    let year = parts.year;
    let month = parts.month;
    let candidate = riyadhLocalToUtc(year, month, day, hour);

    if (candidate.getTime() <= now.getTime()) {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      candidate = riyadhLocalToUtc(year, month, day, hour);
    }
    return candidate;
  }

  const targetDay = Math.min(6, Math.max(0, Number(schedule.dayOfWeek ?? 0)));
  let daysAhead = (targetDay - parts.weekday + 7) % 7;
  let candidate = riyadhLocalToUtc(parts.year, parts.month, parts.day + daysAhead, hour);
  if (candidate.getTime() <= now.getTime()) {
    daysAhead += 7;
    candidate = riyadhLocalToUtc(parts.year, parts.month, parts.day + daysAhead, hour);
  }
  return candidate;
};

export const scheduledTransactionReportPeriod = (frequency, runAt = new Date()) => {
  const parts = riyadhParts(runAt);

  if (frequency === 'monthly') {
    let year = parts.year;
    let month = parts.month - 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    const from = riyadhLocalToUtc(year, month, 1, 0);
    const to = riyadhLocalToUtc(year, month + 1, 1, 0);
    to.setMilliseconds(to.getMilliseconds() - 1);
    return { from, to };
  }

  const thisWeekStartDay = parts.day - parts.weekday;
  const currentWeekStart = riyadhLocalToUtc(parts.year, parts.month, thisWeekStartDay, 0);
  const previousWeekStart = new Date(currentWeekStart.getTime() - 7 * 86400000);
  const previousWeekEnd = new Date(currentWeekStart.getTime() - 1);
  return { from: previousWeekStart, to: previousWeekEnd };
};

export const archiveTransactionExecutiveReport = async ({
  archiveName = null,
  notes = null,
  tags = [],
  reportType,
  from,
  to,
  organizationalUnit = null,
  assigneeUserId = null,
  assigneeName = null,
  scopeMine = false,
  source = 'manual',
  scheduleId = null,
  templateId = null,
  templateName = null,
  templateSnapshot = null,
  generatedById = null,
  generatedByName = null,
}) => {
  const report = await buildTransactionExecutiveReport({
    from,
    to,
    organizationalUnit,
    assigneeUserId,
    scopeMine,
  });

  const summary = buildFlexibleReportSummary(report, templateSnapshot);

  const archive = await prisma.transactionFollowUpReportArchive.create({
    data: {
      archiveName,
      notes,
      tags: Array.isArray(tags) ? tags : [],
      reportType,
      periodFrom: new Date(report.period.from),
      periodTo: new Date(report.period.to),
      organizationalUnit,
      assigneeUserId,
      assigneeName,
      scopeMine,
      source,
      snapshot: report,
      summary,
      scheduleId,
      templateId,
      templateName,
      templateSnapshot,
      generatedById,
      generatedByName,
      updatedById: generatedById,
      updatedByName: generatedByName,
    },
  });

  if (source === 'scheduled') {
    await prisma.auditLog.create({
      data: {
        userId: generatedById,
        username: generatedByName || 'النظام',
        action: 'report_archive_create',
        module: 'transaction_follow_up',
        entity: 'report_archive',
        entityId: archive.id,
        entityLabel: archive.archiveName || archive.templateName || 'تقرير آلي',
        description: 'إنشاء تقرير مؤرشف تلقائيًا بواسطة الجدولة',
        details: {
          source: 'scheduled',
          scheduleId,
          templateId,
          reportType,
        },
      },
    }).catch(() => null);
  }

  return archive;
};

export const syncScheduledTransactionReports = async (now = new Date()) => {
  const schedules = await prisma.transactionFollowUpReportSchedule.findMany({
    where: {
      isActive: true,
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
  });

  let generated = 0;

  for (const schedule of schedules) {
    const runAt = schedule.nextRunAt || now;
    const period = scheduledTransactionReportPeriod(schedule.frequency, runAt);

    const liveTemplate = schedule.templateId
      ? await prisma.transactionFollowUpReportTemplate.findUnique({
          where: { id: schedule.templateId },
        })
      : null;
    const effectiveTemplateSnapshot =
      reportTemplateSnapshot(liveTemplate) || schedule.templateSnapshot || null;
    const templateOptions =
      effectiveTemplateSnapshot?.options && typeof effectiveTemplateSnapshot.options === 'object'
        ? effectiveTemplateSnapshot.options
        : null;
    const effectiveOrganizationalUnit =
      templateOptions?.organizationalUnit || schedule.organizationalUnit || null;

    const existing = await prisma.transactionFollowUpReportArchive.findFirst({
      where: {
        scheduleId: schedule.id,
        periodFrom: period.from,
        periodTo: period.to,
      },
      select: { id: true },
    });

    if (!existing) {
      await archiveTransactionExecutiveReport({
        archiveName: schedule.name || liveTemplate?.name || schedule.templateName || null,
        notes: 'نسخة مؤرشفة تم إنشاؤها تلقائيًا بواسطة جدولة التقارير.',
        tags: [
          'آلي',
          schedule.frequency === 'weekly' ? 'أسبوعي' : 'شهري',
          ...(liveTemplate?.name || schedule.templateName ? ['قالب'] : []),
        ],
        reportType: schedule.frequency,
        from: period.from,
        to: period.to,
        organizationalUnit: effectiveOrganizationalUnit,
        assigneeUserId: schedule.assigneeUserId,
        assigneeName: schedule.assigneeName,
        scopeMine: Boolean(schedule.assigneeUserId),
        source: 'scheduled',
        scheduleId: schedule.id,
        templateId: liveTemplate?.id || schedule.templateId || null,
        templateName: liveTemplate?.name || schedule.templateName || null,
        templateSnapshot: effectiveTemplateSnapshot,
        generatedById: schedule.createdById,
        generatedByName: schedule.createdByName || 'النظام',
      });
      generated += 1;
    }

    await prisma.transactionFollowUpReportSchedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: now,
        nextRunAt: calculateNextTransactionReportRun(schedule, now),
        ...(liveTemplate
          ? {
              templateName: liveTemplate.name,
              templateSnapshot: effectiveTemplateSnapshot,
              organizationalUnit: effectiveOrganizationalUnit,
            }
          : {}),
      },
    });
  }

  return { scanned: schedules.length, generated };
};
