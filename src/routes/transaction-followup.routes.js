import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { deleteGoogleDriveFile } from '../services/googleDrive.js';
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

const directiveCreateSchema = z.object({
  directiveType: z.enum(['directive', 'decision']).default('directive'),
  title: z.string().trim().min(2, 'عنوان التوجيه أو القرار مطلوب').max(300),
  instruction: z.string().trim().min(2, 'نص التوجيه أو القرار مطلوب').max(5000),
  priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
  assigneeUserId: z.string().trim().min(1, 'الموظف المكلف مطلوب'),
  dueDate: nullableText(100),
});

const directiveUpdateSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'awaiting_approval', 'cancelled']),
  completionResponse: nullableText(5000),
  completionNote: nullableText(3000),
});

const directiveReviewSchema = z.object({
  decision: z.enum(['approved', 'return_for_completion', 'request_modification']),
  reviewNote: nullableText(3000),
});

const directiveEvidenceSchema = z.object({
  title: z.string().trim().min(1, 'اسم المرفق مطلوب').max(300),
  driveUrl: z.string().url('رابط الملف غير صحيح'),
  driveFileId: nullableText(300),
  mimeType: nullableText(300),
  notes: nullableText(1000),
});

const kpiTargetSchema = z.object({
  firstPassRateMin: z.coerce.number().min(0).max(100),
  onTimeRateMin: z.coerce.number().min(0).max(100),
  reworkRateMax: z.coerce.number().min(0).max(100),
  avgExecutionHoursMax: z.coerce.number().min(1).max(8760),
  avgApprovalHoursMax: z.coerce.number().min(1).max(8760),
  warningTolerancePercent: z.coerce.number().min(0).max(100),
  alertPeriodDays: z.coerce.number().int().min(7).max(365),
  alertsEnabled: z.boolean(),
});

const preventiveActionCreateSchema = z.object({
  sourceType: z.enum(['metric', 'employee']).default('metric'),
  metricKey: z.enum([
    'firstPassRate',
    'onTimeRate',
    'reworkRate',
    'avgExecutionHours',
    'avgApprovalHours',
  ]).optional().nullable(),
  scopeType: z.enum(['global', 'employee']).default('global'),
  assigneeUserId: nullableText(100),
  ownerUserId: z.string().trim().min(1, 'مسؤول التنفيذ مطلوب'),
  actionText: z.string().trim().min(2, 'الإجراء الوقائي مطلوب').max(5000),
  expectedOutcome: nullableText(3000),
  periodDays: z.coerce.number().int().min(7).max(365).default(30),
  baselineValue: z.coerce.number().optional().nullable(),
  projectedValue: z.coerce.number().optional().nullable(),
  targetValue: z.coerce.number().optional().nullable(),
  direction: z.enum(['min', 'max']).optional().nullable(),
  sourceRiskScore: z.coerce.number().int().min(0).max(100).optional().nullable(),
  sourceRiskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional().nullable(),
  sourceReasons: z.array(z.string().trim().min(1).max(1000)).max(10).optional().default([]),
  dueDate: z.string().trim().min(1, 'تاريخ الاستحقاق مطلوب'),
});

const preventiveActionUpdateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'monitoring', 'cancelled']).optional(),
  ownerUserId: nullableText(100),
  actionText: z.string().trim().min(2).max(5000).optional(),
  expectedOutcome: nullableText(3000),
  dueDate: z.string().trim().optional(),
  progressNote: nullableText(5000),
});

const preventiveActionLinkCapaSchema = z.object({
  improvementPlanId: z.string().trim().min(1, 'خطة CAPA مطلوبة'),
});

const riskRegisterCreateSchema = z.object({
  title: z.string().trim().min(2, 'عنوان الخطر مطلوب').max(500),
  description: z.string().trim().min(2, 'وصف الخطر مطلوب').max(5000),
  category: z.enum([
    'operational',
    'process',
    'workload',
    'compliance',
    'technology',
    'data',
    'financial',
    'reputational',
    'other',
  ]).default('operational'),
  sourceType: z.enum(['manual', 'early_warning', 'preventive_action', 'capa']).default('manual'),
  metricKey: z.enum([
    'firstPassRate',
    'onTimeRate',
    'reworkRate',
    'avgExecutionHours',
    'avgApprovalHours',
  ]).optional().nullable(),
  scopeType: z.enum(['global', 'employee']).default('global'),
  assigneeUserId: nullableText(100),
  ownerUserId: z.string().trim().min(1, 'مالك الخطر مطلوب'),
  probability: z.coerce.number().int().min(1).max(5),
  impact: z.coerce.number().int().min(1).max(5),
  controls: z.array(z.string().trim().min(1).max(1500)).max(20).optional().default([]),
  treatmentStrategy: z.enum(['reduce', 'avoid', 'transfer', 'accept']).default('reduce'),
  treatmentPlan: nullableText(5000),
  residualProbability: z.coerce.number().int().min(1).max(5).optional(),
  residualImpact: z.coerce.number().int().min(1).max(5).optional(),
  reviewDate: nullableText(100),
  sourcePreventiveActionId: nullableText(100),
  sourceImprovementPlanId: nullableText(100),
  recurrenceCount: z.coerce.number().int().min(0).max(100000).optional().default(0),
  notes: nullableText(5000),
});

const riskRegisterUpdateSchema = z.object({
  title: z.string().trim().min(2).max(500).optional(),
  description: z.string().trim().min(2).max(5000).optional(),
  category: z.enum([
    'operational',
    'process',
    'workload',
    'compliance',
    'technology',
    'data',
    'financial',
    'reputational',
    'other',
  ]).optional(),
  ownerUserId: nullableText(100),
  probability: z.coerce.number().int().min(1).max(5).optional(),
  impact: z.coerce.number().int().min(1).max(5).optional(),
  controls: z.array(z.string().trim().min(1).max(1500)).max(20).optional(),
  treatmentStrategy: z.enum(['reduce', 'avoid', 'transfer', 'accept']).optional(),
  treatmentPlan: nullableText(5000),
  residualProbability: z.coerce.number().int().min(1).max(5).optional(),
  residualImpact: z.coerce.number().int().min(1).max(5).optional(),
  reviewDate: nullableText(100),
  status: z.enum(['open', 'monitoring', 'controlled', 'accepted', 'closed']).optional(),
  recurrenceCount: z.coerce.number().int().min(0).max(100000).optional(),
  notes: nullableText(5000),
});

const improvementPlanCreateSchema = z.object({
  metricKey: z.enum([
    'firstPassRate',
    'onTimeRate',
    'reworkRate',
    'avgExecutionHours',
    'avgApprovalHours',
  ]),
  scopeType: z.enum(['global', 'employee']).default('global'),
  assigneeUserId: nullableText(100),
  baselineValue: z.coerce.number().optional().nullable(),
  targetValue: z.coerce.number(),
  direction: z.enum(['min', 'max']),
  periodDays: z.coerce.number().int().min(7).max(365).default(30),
  rootCause: z.string().trim().min(2, 'سبب الانحراف مطلوب').max(4000),
  correctiveAction: z.string().trim().min(2, 'الإجراء التصحيحي مطلوب').max(5000),
  preventiveAction: nullableText(5000),
  ownerUserId: nullableText(100),
  dueDate: z.string().trim().min(1, 'تاريخ الاستحقاق مطلوب'),
});

const improvementPlanUpdateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'monitoring', 'cancelled']).optional(),
  rootCause: z.string().trim().min(2).max(4000).optional(),
  correctiveAction: z.string().trim().min(2).max(5000).optional(),
  preventiveAction: nullableText(5000),
  ownerUserId: nullableText(100),
  dueDate: z.string().trim().optional(),
  progressNote: nullableText(5000),
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

const DEFAULT_KPI_TARGETS = {
  scope: 'global',
  firstPassRateMin: 90,
  onTimeRateMin: 95,
  reworkRateMax: 10,
  avgExecutionHoursMax: 72,
  avgApprovalHoursMax: 24,
  warningTolerancePercent: 10,
  alertPeriodDays: 30,
  alertsEnabled: true,
};

const getKpiTargets = async () => {
  const stored = await prisma.transactionFollowUpKpiTarget.findUnique({
    where: { scope: 'global' },
  });
  return stored || DEFAULT_KPI_TARGETS;
};

const evaluateMetric = (value, target, direction, tolerancePercent) => {
  if (value == null || Number.isNaN(Number(value))) {
    return { status: 'neutral', met: null, value, target, direction };
  }

  if (direction === 'min') {
    if (value >= target) return { status: 'green', met: true, value, target, direction };
    const yellowFloor = Math.max(0, target - tolerancePercent);
    if (value >= yellowFloor) return { status: 'yellow', met: false, value, target, direction };
    return { status: 'red', met: false, value, target, direction };
  }

  if (value <= target) return { status: 'green', met: true, value, target, direction };
  const yellowCeiling = target * (1 + tolerancePercent / 100);
  if (value <= yellowCeiling) return { status: 'yellow', met: false, value, target, direction };
  return { status: 'red', met: false, value, target, direction };
};

const KPI_METRIC_LABELS = {
  firstPassRate: 'الإنجاز من أول مرة',
  onTimeRate: 'الالتزام بالمواعيد',
  reworkRate: 'معدل إعادة العمل',
  avgExecutionHours: 'متوسط زمن التنفيذ',
  avgApprovalHours: 'متوسط زمن الاعتماد',
};

const riskMatrixLevelFromScore = (score) => {
  if (score >= 17) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
};

const riskMatrixScore = (probability, impact) => Number(probability) * Number(impact);

const nextRiskNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `RISK-${year}-`;
  const latest = await prisma.transactionFollowUpRiskRegister.findFirst({
    where: { riskNumber: { startsWith: prefix } },
    orderBy: { riskNumber: 'desc' },
    select: { riskNumber: true },
  });
  const last = Number(latest?.riskNumber?.slice(prefix.length) || 0);
  return `${prefix}${String(last + 1).padStart(4, '0')}`;
};

const serializeRisk = (risk) => {
  const now = new Date();
  const active = !['closed'].includes(risk.status);
  const reviewOverdue = Boolean(
    active &&
    risk.reviewDate &&
    new Date(risk.reviewDate).getTime() < now.getTime()
  );
  return { ...risk, isReviewOverdue: reviewOverdue };
};

const evaluateKpiMetrics = (metrics, targets) => ({
  firstPassRate: evaluateMetric(
    metrics.firstPassRate,
    targets.firstPassRateMin,
    'min',
    targets.warningTolerancePercent,
  ),
  onTimeRate: evaluateMetric(
    metrics.onTimeRate,
    targets.onTimeRateMin,
    'min',
    targets.warningTolerancePercent,
  ),
  reworkRate: evaluateMetric(
    metrics.reworkRate,
    targets.reworkRateMax,
    'max',
    targets.warningTolerancePercent,
  ),
  avgExecutionHours: evaluateMetric(
    metrics.avgExecutionHours,
    targets.avgExecutionHoursMax,
    'max',
    targets.warningTolerancePercent,
  ),
  avgApprovalHours: evaluateMetric(
    metrics.avgApprovalHours,
    targets.avgApprovalHoursMax,
    'max',
    targets.warningTolerancePercent,
  ),
});

const calculateKpiSnapshotRange = async (start, end = null, assigneeUserId = null) => {
  const directives = await prisma.transactionFollowUpDirective.findMany({
    where: {
      ...(assigneeUserId ? { assigneeUserId } : {}),
      reviews: {
        some: {
          reviewedAt: {
            gte: start,
            ...(end ? { lt: end } : {}),
          },
        },
      },
    },
    select: {
      id: true,
      issuedAt: true,
      dueDate: true,
      reviews: {
        select: {
          decision: true,
          submittedAt: true,
          reviewedAt: true,
        },
        orderBy: { reviewedAt: 'asc' },
      },
    },
  });

  const inRange = (value) => {
    const time = new Date(value).getTime();
    return time >= start.getTime() && (!end || time < end.getTime());
  };

  let reviewedDirectives = 0;
  let firstCandidates = 0;
  let firstApproved = 0;
  let reworkedDirectives = 0;
  let completedWithDue = 0;
  let completedOnTime = 0;
  const executionHours = [];
  const approvalHours = [];

  for (const directive of directives) {
    const periodReviews = directive.reviews.filter((review) => inRange(review.reviewedAt));
    if (!periodReviews.length) continue;
    reviewedDirectives += 1;

    if (periodReviews.some((review) =>
      ['return_for_completion', 'request_modification'].includes(review.decision)
    )) {
      reworkedDirectives += 1;
    }

    const firstReview = directive.reviews[0];
    if (firstReview && inRange(firstReview.reviewedAt)) {
      firstCandidates += 1;
      if (firstReview.decision === 'approved') firstApproved += 1;
      if (firstReview.submittedAt) {
        executionHours.push(Math.max(
          0,
          (new Date(firstReview.submittedAt).getTime() - new Date(directive.issuedAt).getTime()) / 3600000,
        ));
      }
    }

    for (const review of periodReviews) {
      if (review.submittedAt) {
        approvalHours.push(Math.max(
          0,
          (new Date(review.reviewedAt).getTime() - new Date(review.submittedAt).getTime()) / 3600000,
        ));
      }
      if (review.decision === 'approved' && directive.dueDate && review.submittedAt) {
        completedWithDue += 1;
        if (
          dayNumberFromKey(saudiDayKey(new Date(review.submittedAt))) <=
          dayNumberFromKey(saudiDayKey(new Date(directive.dueDate)))
        ) {
          completedOnTime += 1;
        }
      }
    }
  }

  const average = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const rounded = (value) => value == null ? null : Number(value.toFixed(1));

  return {
    reviewedDirectives,
    firstPassRate: firstCandidates ? rounded((firstApproved / firstCandidates) * 100) : null,
    reworkRate: reviewedDirectives ? rounded((reworkedDirectives / reviewedDirectives) * 100) : null,
    avgExecutionHours: rounded(average(executionHours)),
    avgApprovalHours: rounded(average(approvalHours)),
    onTimeRate: completedWithDue ? rounded((completedOnTime / completedWithDue) * 100) : null,
  };
};

const calculateCurrentKpiSnapshot = async (periodDays, assigneeUserId = null) => {
  const start = new Date(Date.now() - periodDays * 86400000);
  return calculateKpiSnapshotRange(start, null, assigneeUserId);
};

const KPI_RISK_CONFIG = {
  firstPassRate: { targetField: 'firstPassRateMin', direction: 'min' },
  onTimeRate: { targetField: 'onTimeRateMin', direction: 'min' },
  reworkRate: { targetField: 'reworkRateMax', direction: 'max' },
  avgExecutionHours: { targetField: 'avgExecutionHoursMax', direction: 'max' },
  avgApprovalHours: { targetField: 'avgApprovalHoursMax', direction: 'max' },
};

const riskLevelFromScore = (score) => {
  if (score >= 85) return 'critical';
  if (score >= 65) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
};

const preventiveRecommendation = (metricKey) => {
  const recommendations = {
    firstPassRate: 'مراجعة وضوح التكليف ومتطلبات الإثبات قبل بدء التنفيذ، مع قائمة تحقق قصيرة قبل الرفع.',
    onTimeRate: 'تقليل الأعمال القريبة من الاستحقاق عبر متابعة منتصف المدة وتوزيع الحمل مبكرًا.',
    reworkRate: 'تحليل أسباب الإعادة المتكررة وتوحيد نموذج الإنجاز ومتطلبات القبول قبل الرفع.',
    avgExecutionHours: 'تفكيك التوجيه إلى خطوات قصيرة وتحديد نقاط متابعة وسيطة قبل تاريخ الاستحقاق.',
    avgApprovalHours: 'تخصيص نافذة مراجعة يومية للتوجيهات المرفوعة وترتيبها حسب الاستحقاق والأولوية.',
  };
  return recommendations[metricKey] || 'مراجعة أسباب التراجع واتخاذ إجراء وقائي قبل تجاوز المستهدف.';
};

const projectMetricRisk = (metricKey, currentValue, previousValue, targets, reviewedDirectives = 0) => {
  const config = KPI_RISK_CONFIG[metricKey];
  const target = Number(targets[config.targetField]);
  const direction = config.direction;
  const currentEvaluation = evaluateMetric(
    currentValue,
    target,
    direction,
    targets.warningTolerancePercent,
  );

  if (currentValue == null) {
    return {
      metricKey,
      metricLabel: KPI_METRIC_LABELS[metricKey],
      currentValue: null,
      previousValue: previousValue ?? null,
      delta: null,
      projectedValue: null,
      target,
      direction,
      currentStatus: 'neutral',
      projectedStatus: 'neutral',
      riskScore: 0,
      riskLevel: 'low',
      confidence: 'low',
      reasons: ['لا توجد بيانات كافية لاحتساب اتجاه موثوق.'],
      recommendation: preventiveRecommendation(metricKey),
    };
  }

  const delta = previousValue == null ? null : Number((currentValue - previousValue).toFixed(1));
  let projectedValue = delta == null ? currentValue : currentValue + delta;
  if (metricKey.endsWith('Rate')) projectedValue = Math.max(0, Math.min(100, projectedValue));
  else projectedValue = Math.max(0, projectedValue);
  projectedValue = Number(projectedValue.toFixed(1));

  const projectedEvaluation = evaluateMetric(
    projectedValue,
    target,
    direction,
    targets.warningTolerancePercent,
  );
  const deteriorating = delta != null && (direction === 'min' ? delta < 0 : delta > 0);
  const targetMarginPercent = target
    ? (
        direction === 'min'
          ? ((currentValue - target) / Math.abs(target)) * 100
          : ((target - currentValue) / Math.abs(target)) * 100
      )
    : null;
  const nearTarget = currentEvaluation.status === 'green' &&
    targetMarginPercent != null &&
    targetMarginPercent <= 5;

  let riskScore = 15;
  if (currentEvaluation.status === 'red') riskScore = 100;
  else if (projectedEvaluation.status === 'red') riskScore = 90;
  else if (currentEvaluation.status === 'yellow') riskScore = 78;
  else if (projectedEvaluation.status === 'yellow') riskScore = 68;
  else if (deteriorating) riskScore = 48;
  if (nearTarget) riskScore = Math.max(riskScore, 42);
  if (deteriorating && projectedEvaluation.status !== 'green') riskScore = Math.min(100, riskScore + 5);

  const reasons = [];
  if (currentEvaluation.status === 'red') reasons.push('المؤشر متجاوز للمستهدف حاليًا.');
  else if (currentEvaluation.status === 'yellow') reasons.push('المؤشر دخل نطاق التحذير قبل المستوى الأحمر.');
  if (projectedEvaluation.status === 'red' && currentEvaluation.status !== 'red') {
    reasons.push('استمرار الاتجاه الحالي يتوقع تجاوز المستهدف في فترة القياس القادمة.');
  } else if (projectedEvaluation.status === 'yellow' && currentEvaluation.status === 'green') {
    reasons.push('استمرار الاتجاه الحالي يتوقع دخول المؤشر نطاق التحذير.');
  }
  if (deteriorating) reasons.push('الاتجاه الحالي أسوأ من الفترة السابقة.');
  if (nearTarget) reasons.push('الهامش الحالي عن المستهدف محدود.');
  if (!reasons.length) reasons.push('المؤشر مستقر حاليًا ولا توجد إشارة مبكرة قوية.');

  const confidence =
    reviewedDirectives >= 12 ? 'high' :
      reviewedDirectives >= 6 ? 'medium' : 'low';

  return {
    metricKey,
    metricLabel: KPI_METRIC_LABELS[metricKey],
    currentValue,
    previousValue: previousValue ?? null,
    delta,
    projectedValue,
    target,
    direction,
    currentStatus: currentEvaluation.status,
    projectedStatus: projectedEvaluation.status,
    riskScore,
    riskLevel: riskLevelFromScore(riskScore),
    confidence,
    reasons,
    recommendation: preventiveRecommendation(metricKey),
  };
};

const buildEarlyWarningSnapshot = async (periodDays = 30, suppliedTargets = null) => {
  const safePeriodDays = Math.min(90, Math.max(14, Number(periodDays) || 30));
  const now = new Date();
  const currentStart = new Date(now.getTime() - safePeriodDays * 86400000);
  const previousStart = new Date(now.getTime() - safePeriodDays * 2 * 86400000);
  const targets = suppliedTargets || await getKpiTargets();

  const [current, previous, users, openDirectives] = await Promise.all([
    calculateKpiSnapshotRange(currentStart, now),
    calculateKpiSnapshotRange(previousStart, currentStart),
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
    prisma.transactionFollowUpDirective.findMany({
      where: { status: { in: ['pending', 'in_progress', 'returned', 'awaiting_approval'] } },
      select: {
        assigneeUserId: true,
        assigneeName: true,
        priority: true,
        status: true,
        dueDate: true,
      },
    }),
  ]);

  const metrics = Object.keys(KPI_RISK_CONFIG)
    .map((metricKey) =>
      projectMetricRisk(
        metricKey,
        current[metricKey],
        previous[metricKey],
        targets,
        current.reviewedDirectives,
      )
    )
    .sort((a, b) => b.riskScore - a.riskScore);

  const openByUser = new Map();
  for (const row of openDirectives) {
    const currentItem = openByUser.get(row.assigneeUserId) || {
      open: 0,
      overdue: 0,
      urgent: 0,
      returned: 0,
      name: row.assigneeName || 'مستخدم',
    };
    currentItem.open += 1;
    if (row.priority === 'urgent') currentItem.urgent += 1;
    if (row.status === 'returned') currentItem.returned += 1;
    if (
      row.dueDate &&
      dayNumberFromKey(saudiDayKey(new Date(row.dueDate))) <
        dayNumberFromKey(saudiDayKey(now))
    ) {
      currentItem.overdue += 1;
    }
    openByUser.set(row.assigneeUserId, currentItem);
  }

  const employeeRisks = [];
  for (const user of users) {
    const [employeeCurrent, employeePrevious] = await Promise.all([
      calculateKpiSnapshotRange(currentStart, now, user.id),
      calculateKpiSnapshotRange(previousStart, currentStart, user.id),
    ]);
    const operational = openByUser.get(user.id) || {
      open: 0,
      overdue: 0,
      urgent: 0,
      returned: 0,
      name: user.username,
    };
    const employeeMetrics = Object.keys(KPI_RISK_CONFIG)
      .map((metricKey) =>
        projectMetricRisk(
          metricKey,
          employeeCurrent[metricKey],
          employeePrevious[metricKey],
          targets,
          employeeCurrent.reviewedDirectives,
        )
      )
      .sort((a, b) => b.riskScore - a.riskScore);

    const metricRisk = employeeMetrics[0]?.riskScore || 0;
    const operationalRisk = Math.min(
      95,
      operational.overdue * 18 +
        operational.urgent * 10 +
        operational.returned * 12 +
        Math.max(0, operational.open - 5) * 4,
    );
    const riskScore = Math.max(metricRisk, operationalRisk);
    if (
      !employeeCurrent.reviewedDirectives &&
      !employeePrevious.reviewedDirectives &&
      !operational.open
    ) {
      continue;
    }

    const reasons = [];
    const topMetric = employeeMetrics[0];
    if (topMetric?.riskScore >= 40) {
      reasons.push(`${topMetric.metricLabel}: ${topMetric.reasons[0]}`);
    }
    if (operational.overdue) reasons.push(`${operational.overdue} توجيه متأخر مفتوح.`);
    if (operational.urgent) reasons.push(`${operational.urgent} توجيه عاجل مفتوح.`);
    if (operational.returned) reasons.push(`${operational.returned} توجيه معاد للاستكمال.`);
    if (!reasons.length) reasons.push('المؤشرات التشغيلية ضمن مستوى مستقر حاليًا.');

    employeeRisks.push({
      userId: user.id,
      username: user.username,
      riskScore,
      riskLevel: riskLevelFromScore(riskScore),
      confidence:
        employeeCurrent.reviewedDirectives >= 12 ? 'high' :
          employeeCurrent.reviewedDirectives >= 6 ? 'medium' : 'low',
      openDirectives: operational.open,
      overdueOpen: operational.overdue,
      urgentOpen: operational.urgent,
      returnedOpen: operational.returned,
      reviewedDirectives: employeeCurrent.reviewedDirectives,
      topMetric: topMetric || null,
      predictedBreaches: employeeMetrics.filter(
        (metric) => metric.currentStatus !== 'red' && metric.projectedStatus === 'red'
      ).length,
      reasons,
      recommendation: topMetric?.recommendation || 'الحفاظ على وتيرة المتابعة الحالية.',
    });
  }

  employeeRisks.sort((a, b) =>
    (b.riskScore - a.riskScore) ||
    (b.overdueOpen - a.overdueOpen) ||
    (b.openDirectives - a.openDirectives)
  );

  const predictedMetricBreaches = metrics.filter(
    (metric) => metric.currentStatus !== 'red' && metric.projectedStatus === 'red'
  ).length;
  const atRiskMetrics = metrics.filter((metric) => ['critical', 'high'].includes(metric.riskLevel)).length;
  const atRiskEmployees = employeeRisks.filter(
    (employee) => ['critical', 'high'].includes(employee.riskLevel)
  ).length;

  return {
    generatedAt: now,
    methodology: 'rule_based_linear_trend',
    periodDays: safePeriodDays,
    targets,
    summary: {
      atRiskMetrics,
      predictedMetricBreaches,
      atRiskEmployees,
      criticalEmployees: employeeRisks.filter((item) => item.riskLevel === 'critical').length,
      highRiskEmployees: employeeRisks.filter((item) => item.riskLevel === 'high').length,
      mediumRiskEmployees: employeeRisks.filter((item) => item.riskLevel === 'medium').length,
    },
    metrics,
    employees: employeeRisks.slice(0, 20),
  };
};

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

const serializeDirective = (directive) => {
  const now = new Date();
  const final = ['completed', 'cancelled'].includes(directive.status);
  const todayKey = saudiDayKey(now);
  const dueKey = directive.dueDate ? saudiDayKey(new Date(directive.dueDate)) : null;
  const todayNumber = dayNumberFromKey(todayKey);
  const dueNumber = dueKey ? dayNumberFromKey(dueKey) : null;
  const overdue = !final && dueNumber != null && dueNumber < todayNumber;
  const dueToday = !final && dueKey === todayKey;

  return {
    ...directive,
    isOverdue: Boolean(overdue),
    isDueToday: Boolean(dueToday),
    daysOverdue: overdue ? Math.max(1, todayNumber - dueNumber) : 0,
  };
};

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
  const [rows, directives, improvementPlans, preventiveActions, risks] = await Promise.all([
    prisma.transactionFollowUp.findMany({
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
    }),
    prisma.transactionFollowUpDirective.findMany({
      where: {
        status: { in: ['pending', 'in_progress', 'returned'] },
        dueDate: { not: null },
      },
      include: {
        transaction: {
          select: { id: true, transactionNumber: true, subject: true },
        },
      },
    }),
    prisma.transactionFollowUpImprovementPlan.findMany({
      where: {
        status: { in: ['open', 'in_progress', 'monitoring'] },
      },
      select: {
        id: true,
        metricLabel: true,
        scopeType: true,
        assigneeName: true,
        ownerName: true,
        dueDate: true,
        status: true,
      },
    }),
    prisma.transactionFollowUpPreventiveAction.findMany({
      where: {
        status: { in: ['open', 'in_progress', 'monitoring'] },
      },
      select: {
        id: true,
        sourceType: true,
        metricLabel: true,
        scopeType: true,
        assigneeName: true,
        ownerUserId: true,
        ownerName: true,
        dueDate: true,
        status: true,
      },
    }),
    prisma.transactionFollowUpRiskRegister.findMany({
      where: {
        status: { in: ['open', 'monitoring', 'accepted'] },
        reviewDate: { not: null },
      },
      select: {
        id: true,
        riskNumber: true,
        title: true,
        ownerUserId: true,
        ownerName: true,
        residualLevel: true,
        reviewDate: true,
        status: true,
      },
    }),
  ]);

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

  const todayKey = saudiDayKey();
  const todayNumber = dayNumberFromKey(todayKey);

  for (const directive of directives) {
    const dueKey = saudiDayKey(new Date(directive.dueDate));
    const dueNumber = dayNumberFromKey(dueKey);
    const daysOverdue = Math.max(0, todayNumber - dueNumber);
    const dueToday = dueKey === todayKey;
    if (!daysOverdue && !dueToday) continue;

    const title = directive.directiveType === 'decision' ? 'قرار إداري' : 'توجيه إداري';
    const severity = daysOverdue ? 'danger' : 'warning';
    const kind = daysOverdue ? 'directive_overdue' : 'directive_due_today';
    const message = daysOverdue
      ? `${title}: ${directive.title} — المعاملة ${directive.transaction.transactionNumber}. متأخر ${daysOverdue} يوم.`
      : `${title}: ${directive.title} — المعاملة ${directive.transaction.transactionNumber}. مستحق اليوم.`;

    await createFollowUpAlert({
      alertKey: `${directive.transactionId}:${directive.id}:${kind}:${todayKey}:${directive.assigneeUserId}`,
      transactionId: directive.transactionId,
      userId: directive.assigneeUserId,
      kind,
      severity,
      title: daysOverdue ? 'توجيه إداري متأخر' : 'توجيه إداري مستحق اليوم',
      message,
    });
    alerts += 1;

    if (daysOverdue) {
      for (const supervisorId of supervisorIds) {
        if (supervisorId === directive.assigneeUserId) continue;
        await createFollowUpAlert({
          alertKey: `${directive.transactionId}:${directive.id}:directive_escalation:${todayKey}:${supervisorId}`,
          transactionId: directive.transactionId,
          userId: supervisorId,
          kind: 'directive_escalation',
          severity: 'danger',
          title: 'تصعيد توجيه إداري متأخر',
          message,
        });
        alerts += 1;
      }
    }
  }

  for (const plan of improvementPlans) {
    const dueKey = saudiDayKey(new Date(plan.dueDate));
    const dueNumber = dayNumberFromKey(dueKey);
    const daysOverdue = Math.max(0, todayNumber - dueNumber);
    const dueToday = dueKey === todayKey;
    if (!daysOverdue && !dueToday) continue;

    const scopeLabel = plan.scopeType === 'employee' && plan.assigneeName
      ? ` للموظف ${plan.assigneeName}`
      : '';
    const kind = daysOverdue ? 'capa_overdue' : 'capa_due_today';
    const severity = daysOverdue ? 'danger' : 'warning';
    const title = daysOverdue ? 'خطة تحسين أداء متأخرة' : 'خطة تحسين أداء مستحقة اليوم';
    const message = daysOverdue
      ? `خطة تحسين مؤشر «${plan.metricLabel}»${scopeLabel} متأخرة ${daysOverdue} يوم.`
      : `خطة تحسين مؤشر «${plan.metricLabel}»${scopeLabel} مستحقة اليوم.`;

    for (const supervisorId of supervisorIds) {
      await createFollowUpAlert({
        alertKey: `capa:${plan.id}:${kind}:${todayKey}:${supervisorId}`,
        transactionId: null,
        userId: supervisorId,
        kind,
        severity,
        title,
        message,
      });
      alerts += 1;
    }
  }

  for (const action of preventiveActions) {
    const dueKey = saudiDayKey(new Date(action.dueDate));
    const dueNumber = dayNumberFromKey(dueKey);
    const daysOverdue = Math.max(0, todayNumber - dueNumber);
    const dueToday = dueKey === todayKey;
    if (!daysOverdue && !dueToday) continue;

    const subject = action.metricLabel
      ? `مؤشر «${action.metricLabel}»`
      : action.assigneeName
        ? `المخاطر التشغيلية للموظف ${action.assigneeName}`
        : 'المخاطر التشغيلية';
    const kind = daysOverdue ? 'preventive_action_overdue' : 'preventive_action_due_today';
    const severity = daysOverdue ? 'danger' : 'warning';
    const title = daysOverdue ? 'إجراء وقائي متأخر' : 'حان موعد قياس أثر إجراء وقائي';
    const message = daysOverdue
      ? `${subject} — الإجراء الوقائي متأخر ${daysOverdue} يوم، ويلزم تحديث التنفيذ وقياس الأثر.`
      : `${subject} — الإجراء الوقائي مستحق اليوم، ويلزم قياس أثره قبل الانتقال إلى CAPA.`;

    const recipients = new Set([action.ownerUserId, ...supervisorIds].filter(Boolean));
    for (const userId of recipients) {
      await createFollowUpAlert({
        alertKey: `preventive:${action.id}:${kind}:${todayKey}:${userId}`,
        transactionId: null,
        userId,
        kind,
        severity,
        title,
        message,
      });
      alerts += 1;
    }
  }

  for (const risk of risks) {
    const reviewKey = risk.reviewDate ? saudiDayKey(new Date(risk.reviewDate)) : null;
    if (!reviewKey) continue;
    const reviewNumber = dayNumberFromKey(reviewKey);
    const daysOverdue = Math.max(0, todayNumber - reviewNumber);
    const dueToday = reviewKey === todayKey;
    if (!daysOverdue && !dueToday) continue;

    const kind = daysOverdue ? 'risk_review_overdue' : 'risk_review_due_today';
    const severity = ['critical', 'high'].includes(risk.residualLevel) || daysOverdue ? 'danger' : 'warning';
    const title = daysOverdue ? 'مراجعة خطر تشغيلي متأخرة' : 'مراجعة خطر تشغيلي مستحقة اليوم';
    const message = daysOverdue
      ? `${risk.riskNumber} — ${risk.title}. مراجعة الخطر متأخرة ${daysOverdue} يوم.`
      : `${risk.riskNumber} — ${risk.title}. حان موعد إعادة تقييم الخطر المتبقي.`;

    const recipients = new Set([risk.ownerUserId, ...supervisorIds].filter(Boolean));
    for (const userId of recipients) {
      await createFollowUpAlert({
        alertKey: `risk:${risk.id}:${kind}:${todayKey}:${userId}`,
        transactionId: null,
        userId,
        kind,
        severity,
        title,
        message,
      });
      alerts += 1;
    }
  }

  const targets = await getKpiTargets();
  if (targets.alertsEnabled && supervisorIds.length) {
    const earlyWarning = await buildEarlyWarningSnapshot(targets.alertPeriodDays, targets);
    const projectedBreaches = earlyWarning.metrics.filter(
      (metric) => metric.currentStatus !== 'red' && metric.projectedStatus === 'red',
    );
    const riskyEmployees = earlyWarning.employees.filter(
      (employee) => ['critical', 'high'].includes(employee.riskLevel),
    ).slice(0, 3);

    for (const metric of projectedBreaches) {
      for (const supervisorId of supervisorIds) {
        await createFollowUpAlert({
          alertKey: `early-warning:metric:${metric.metricKey}:${todayKey}:${supervisorId}`,
          transactionId: null,
          userId: supervisorId,
          kind: 'early_warning_kpi',
          severity: metric.riskLevel === 'critical' ? 'danger' : 'warning',
          title: `إنذار مبكر: ${metric.metricLabel}`,
          message: `الاتجاه الحالي يتوقع انتقال المؤشر إلى المستوى الأحمر. الحالي ${metric.currentValue ?? '—'}، والمتوقع ${metric.projectedValue ?? '—'}، والمستهدف ${metric.direction === 'min' ? '≥' : '≤'} ${metric.target}.`,
        });
        alerts += 1;
      }
    }

    for (const employee of riskyEmployees) {
      for (const supervisorId of supervisorIds) {
        await createFollowUpAlert({
          alertKey: `early-warning:employee:${employee.userId}:${todayKey}:${supervisorId}`,
          transactionId: null,
          userId: supervisorId,
          kind: 'early_warning_employee',
          severity: employee.riskLevel === 'critical' ? 'danger' : 'warning',
          title: `إنذار مبكر تشغيلي: ${employee.username}`,
          message: `مؤشر المخاطر ${employee.riskScore}/100. ${employee.reasons.slice(0, 2).join(' ')}`,
        });
        alerts += 1;
      }
    }

    const snapshot = await calculateCurrentKpiSnapshot(targets.alertPeriodDays);
    if (snapshot.reviewedDirectives > 0) {
      const evaluation = evaluateKpiMetrics(snapshot, targets);
      const labels = {
        firstPassRate: 'الإنجاز من أول مرة',
        onTimeRate: 'الالتزام بالمواعيد',
        reworkRate: 'معدل إعادة العمل',
        avgExecutionHours: 'متوسط زمن التنفيذ',
        avgApprovalHours: 'متوسط زمن الاعتماد',
      };
      const formatKpi = (key, value) =>
        key.includes('Rate') ? `${value}%` : `${value} ساعة`;

      for (const [key, result] of Object.entries(evaluation)) {
        if (!['yellow', 'red'].includes(result.status)) continue;
        const targetText = result.direction === 'min'
          ? `المستهدف ≥ ${formatKpi(key, result.target)}`
          : `المستهدف ≤ ${formatKpi(key, result.target)}`;
        const severity = result.status === 'red' ? 'danger' : 'warning';

        for (const supervisorId of supervisorIds) {
          await createFollowUpAlert({
            alertKey: `kpi:${key}:${todayKey}:${supervisorId}`,
            transactionId: null,
            userId: supervisorId,
            kind: 'kpi_target_breach',
            severity,
            title: `تنبيه KPI: ${labels[key]}`,
            message: `${labels[key]} الحالي ${formatKpi(key, result.value)} — ${targetText}. الفترة: آخر ${targets.alertPeriodDays} يومًا.`,
          });
          alerts += 1;
        }
      }
    }
  }

  return { scanned: rows.length + directives.length + improvementPlans.length + preventiveActions.length + risks.length, alerts };
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

router.get('/directives/dashboard', async (req, res, next) => {
  try {
    const supervisor = isSupervisor(req);
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const priority = String(req.query.priority || '').trim();
    const requestedAssignee = String(req.query.assigneeUserId || '').trim();
    const assigneeUserId = supervisor
      ? (requestedAssignee || null)
      : req.authUser.id;

    const baseWhere = {
      ...(assigneeUserId ? { assigneeUserId } : {}),
    };

    const itemWhere = {
      ...baseWhere,
      ...(['pending', 'in_progress', 'awaiting_approval', 'returned', 'completed', 'cancelled'].includes(status) ? { status } : {}),
      ...(['normal', 'high', 'urgent'].includes(priority) ? { priority } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { instruction: { contains: search, mode: 'insensitive' } },
              { assigneeName: { contains: search, mode: 'insensitive' } },
              { transaction: { transactionNumber: { contains: search, mode: 'insensitive' } } },
              { transaction: { subject: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const now = new Date();
    const todayKey = saudiDayKey(now);
    const todayNumber = dayNumberFromKey(todayKey);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

    const [allRows, itemRows] = await Promise.all([
      prisma.transactionFollowUpDirective.findMany({
        where: baseWhere,
        include: {
          transaction: {
            select: {
              id: true,
              transactionNumber: true,
              trackingNumber: true,
              subject: true,
              status: true,
              currentAssigneeName: true,
            },
          },
        },
      }),
      prisma.transactionFollowUpDirective.findMany({
        where: itemWhere,
        include: {
          transaction: {
            select: {
              id: true,
              transactionNumber: true,
              trackingNumber: true,
              subject: true,
              status: true,
              currentAssigneeName: true,
            },
          },
        },
        orderBy: [
          { status: 'asc' },
          { priority: 'desc' },
          { dueDate: { sort: 'asc', nulls: 'last' } },
          { issuedAt: 'desc' },
        ],
        take: 100,
      }),
    ]);

    const summary = {
      total: allRows.length,
      open: 0,
      pending: 0,
      inProgress: 0,
      awaitingApproval: 0,
      returned: 0,
      overdue: 0,
      dueToday: 0,
      dueSoon: 0,
      completed7d: 0,
      issuedToday: 0,
      urgentOpen: 0,
      decisions: 0,
      directives: 0,
    };

    const employeeMap = new Map();

    for (const row of allRows) {
      const serialized = serializeDirective(row);
      const open = ['pending', 'in_progress', 'awaiting_approval', 'returned'].includes(row.status);
      if (open) summary.open += 1;
      if (row.status === 'pending') summary.pending += 1;
      if (row.status === 'in_progress') summary.inProgress += 1;
      if (row.status === 'awaiting_approval') summary.awaitingApproval += 1;
      if (row.status === 'returned') summary.returned += 1;
      if (serialized.isOverdue) summary.overdue += 1;
      if (serialized.isDueToday) summary.dueToday += 1;
      if (
        open &&
        row.dueDate &&
        !serialized.isOverdue &&
        !serialized.isDueToday
      ) {
        const dueNumber = dayNumberFromKey(saudiDayKey(new Date(row.dueDate)));
        const daysUntilDue = dueNumber - todayNumber;
        if (daysUntilDue >= 1 && daysUntilDue <= 3) summary.dueSoon += 1;
      }
      if (row.status === 'completed' && row.completedAt && new Date(row.completedAt) >= sevenDaysAgo) {
        summary.completed7d += 1;
      }
      if (saudiDayKey(new Date(row.issuedAt)) === todayKey) summary.issuedToday += 1;
      if (open && row.priority === 'urgent') summary.urgentOpen += 1;
      if (row.directiveType === 'decision') summary.decisions += 1;
      else summary.directives += 1;

      const employee = employeeMap.get(row.assigneeUserId) || {
        userId: row.assigneeUserId,
        username: row.assigneeName,
        open: 0,
        pending: 0,
        inProgress: 0,
        awaitingApproval: 0,
        returned: 0,
        overdue: 0,
        completed: 0,
        urgent: 0,
      };
      if (open) employee.open += 1;
      if (row.status === 'pending') employee.pending += 1;
      if (row.status === 'in_progress') employee.inProgress += 1;
      if (row.status === 'awaiting_approval') employee.awaitingApproval += 1;
      if (row.status === 'returned') employee.returned += 1;
      if (serialized.isOverdue) employee.overdue += 1;
      if (row.status === 'completed') employee.completed += 1;
      if (open && row.priority === 'urgent') employee.urgent += 1;
      employeeMap.set(row.assigneeUserId, employee);
    }

    const employees = [...employeeMap.values()]
      .sort((a, b) =>
        (b.overdue - a.overdue) ||
        (b.urgent - a.urgent) ||
        (b.open - a.open) ||
        (b.completed - a.completed)
      );

    const dashboardDirectiveIds = itemRows.map((row) => row.id);
    const dashboardEvidence = dashboardDirectiveIds.length
      ? await prisma.attachment.findMany({
          where: {
            entityType: 'transaction_follow_up_directive',
            entityId: { in: dashboardDirectiveIds },
          },
          select: { id: true, entityId: true },
        })
      : [];
    const evidenceCountByDirective = new Map();
    dashboardEvidence.forEach((item) => {
      evidenceCountByDirective.set(
        item.entityId,
        (evidenceCountByDirective.get(item.entityId) || 0) + 1,
      );
    });

    const items = itemRows.map((row) => ({
      ...serializeDirective(row),
      evidenceCount: evidenceCountByDirective.get(row.id) || 0,
      transaction: row.transaction,
    }));

    res.json({
      generatedAt: now,
      scope: supervisor && !requestedAssignee ? 'all' : 'mine_or_employee',
      summary,
      employees,
      items,
      totalItems: items.length,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/directives/approval-center', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'مركز اعتماد الإنجازات متاح للمستخدم الإشرافي فقط' });
    }

    const search = String(req.query.search || '').trim();
    const priority = String(req.query.priority || '').trim();
    const assigneeUserId = String(req.query.assigneeUserId || '').trim();

    const where = {
      status: 'awaiting_approval',
      ...(assigneeUserId ? { assigneeUserId } : {}),
      ...(['normal', 'high', 'urgent'].includes(priority) ? { priority } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { instruction: { contains: search, mode: 'insensitive' } },
              { completionResponse: { contains: search, mode: 'insensitive' } },
              { assigneeName: { contains: search, mode: 'insensitive' } },
              { transaction: { transactionNumber: { contains: search, mode: 'insensitive' } } },
              { transaction: { subject: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const rows = await prisma.transactionFollowUpDirective.findMany({
      where,
      include: {
        transaction: {
          select: {
            id: true,
            transactionNumber: true,
            trackingNumber: true,
            transactionDate: true,
            subject: true,
            priority: true,
            status: true,
            currentAssigneeName: true,
          },
        },
      },
      orderBy: [
        { completionSubmittedAt: { sort: 'asc', nulls: 'last' } },
        { dueDate: { sort: 'asc', nulls: 'last' } },
        { issuedAt: 'asc' },
      ],
      take: 100,
    });

    const directiveIds = rows.map((row) => row.id);
    const evidence = directiveIds.length
      ? await prisma.attachment.findMany({
          where: {
            entityType: 'transaction_follow_up_directive',
            entityId: { in: directiveIds },
          },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    const evidenceByDirective = new Map();
    evidence.forEach((item) => {
      const items = evidenceByDirective.get(item.entityId) || [];
      items.push(item);
      evidenceByDirective.set(item.entityId, items);
    });

    const now = new Date();
    const todayNumber = dayNumberFromKey(saudiDayKey(now));
    const summary = {
      awaitingApproval: rows.length,
      urgent: 0,
      overdue: 0,
      withoutEvidence: 0,
      waitingOver2Days: 0,
    };
    const employeeMap = new Map();

    const items = rows
      .map((row) => {
        const serialized = serializeDirective(row);
        const submittedAt = row.completionSubmittedAt || row.updatedAt || row.issuedAt;
        const submittedDay = dayNumberFromKey(saudiDayKey(new Date(submittedAt)));
        const waitingDays = Math.max(0, todayNumber - submittedDay);
        const attachments = evidenceByDirective.get(row.id) || [];

        if (row.priority === 'urgent') summary.urgent += 1;
        if (serialized.isOverdue) summary.overdue += 1;
        if (!attachments.length) summary.withoutEvidence += 1;
        if (waitingDays >= 2) summary.waitingOver2Days += 1;

        const employee = employeeMap.get(row.assigneeUserId) || {
          userId: row.assigneeUserId,
          username: row.assigneeName,
          awaitingApproval: 0,
          urgent: 0,
          withoutEvidence: 0,
          maxWaitingDays: 0,
        };
        employee.awaitingApproval += 1;
        if (row.priority === 'urgent') employee.urgent += 1;
        if (!attachments.length) employee.withoutEvidence += 1;
        employee.maxWaitingDays = Math.max(employee.maxWaitingDays, waitingDays);
        employeeMap.set(row.assigneeUserId, employee);

        return {
          ...serialized,
          waitingDays,
          evidence: attachments,
          transaction: row.transaction,
        };
      })
      .sort((a, b) => {
        const priorityRank = { urgent: 3, high: 2, normal: 1 };
        return (
          (priorityRank[b.priority] - priorityRank[a.priority]) ||
          (b.waitingDays - a.waitingDays) ||
          (Number(b.isOverdue) - Number(a.isOverdue))
        );
      });

    const employees = [...employeeMap.values()]
      .sort((a, b) =>
        (b.awaitingApproval - a.awaitingApproval) ||
        (b.urgent - a.urgent) ||
        (b.maxWaitingDays - a.maxWaitingDays)
      );

    res.json({
      generatedAt: now,
      summary,
      employees,
      items,
      totalItems: items.length,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/directives/approval-history', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'سجل الاعتمادات متاح للمستخدم الإشرافي فقط' });
    }

    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(10, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));
    const search = String(req.query.search || '').trim();
    const decision = String(req.query.decision || '').trim();
    const assigneeUserId = String(req.query.assigneeUserId || '').trim();
    const reviewerUserId = String(req.query.reviewerUserId || '').trim();
    const periodDaysRaw = String(req.query.periodDays || '90').trim();
    const periodDays = periodDaysRaw === 'all'
      ? null
      : Math.min(3650, Math.max(1, Number.parseInt(periodDaysRaw, 10) || 90));
    const periodStart = periodDays
      ? new Date(Date.now() - periodDays * 86400000)
      : null;

    const where = {
      ...(periodStart ? { reviewedAt: { gte: periodStart } } : {}),
      ...(['approved', 'return_for_completion', 'request_modification'].includes(decision)
        ? { decision }
        : {}),
      ...(reviewerUserId ? { reviewedById: reviewerUserId } : {}),
      ...(assigneeUserId ? { directive: { assigneeUserId } } : {}),
      ...(search
        ? {
            OR: [
              { reviewNote: { contains: search, mode: 'insensitive' } },
              { completionResponse: { contains: search, mode: 'insensitive' } },
              { reviewedByName: { contains: search, mode: 'insensitive' } },
              { directive: { title: { contains: search, mode: 'insensitive' } } },
              { directive: { assigneeName: { contains: search, mode: 'insensitive' } } },
              { directive: { transaction: { transactionNumber: { contains: search, mode: 'insensitive' } } } },
              { directive: { transaction: { subject: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const [total, rows, allRows] = await Promise.all([
      prisma.transactionFollowUpDirectiveReview.count({ where }),
      prisma.transactionFollowUpDirectiveReview.findMany({
        where,
        include: {
          directive: {
            select: {
              id: true,
              directiveType: true,
              title: true,
              instruction: true,
              priority: true,
              status: true,
              assigneeUserId: true,
              assigneeName: true,
              dueDate: true,
              issuedByName: true,
              issuedAt: true,
              transaction: {
                select: {
                  id: true,
                  transactionNumber: true,
                  trackingNumber: true,
                  transactionDate: true,
                  subject: true,
                  status: true,
                  currentAssigneeName: true,
                },
              },
            },
          },
        },
        orderBy: { reviewedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.transactionFollowUpDirectiveReview.findMany({
        where,
        select: {
          id: true,
          directiveId: true,
          decision: true,
          submittedAt: true,
          reviewedAt: true,
          reviewedById: true,
          reviewedByName: true,
          directive: {
            select: {
              assigneeUserId: true,
              assigneeName: true,
            },
          },
        },
      }),
    ]);

    const summary = {
      total: allRows.length,
      approved: 0,
      returned: 0,
      modificationRequested: 0,
      uniqueDirectives: new Set(allRows.map((item) => item.directiveId)).size,
      averageReviewHours: null,
    };

    const employeeMap = new Map();
    const reviewerMap = new Map();
    let reviewHoursTotal = 0;
    let reviewHoursCount = 0;

    for (const row of allRows) {
      if (row.decision === 'approved') summary.approved += 1;
      if (row.decision === 'return_for_completion') summary.returned += 1;
      if (row.decision === 'request_modification') summary.modificationRequested += 1;

      if (row.submittedAt) {
        const hours = Math.max(
          0,
          (new Date(row.reviewedAt).getTime() - new Date(row.submittedAt).getTime()) / 3600000,
        );
        reviewHoursTotal += hours;
        reviewHoursCount += 1;
      }

      const employee = employeeMap.get(row.directive.assigneeUserId) || {
        userId: row.directive.assigneeUserId,
        username: row.directive.assigneeName,
        reviews: 0,
        approved: 0,
        returned: 0,
        modificationRequested: 0,
      };
      employee.reviews += 1;
      if (row.decision === 'approved') employee.approved += 1;
      if (row.decision === 'return_for_completion') employee.returned += 1;
      if (row.decision === 'request_modification') employee.modificationRequested += 1;
      employeeMap.set(employee.userId, employee);

      const reviewerKey = row.reviewedById || row.reviewedByName || 'unknown';
      const reviewer = reviewerMap.get(reviewerKey) || {
        userId: row.reviewedById || null,
        username: row.reviewedByName || 'مستخدم إشرافي',
        reviews: 0,
        approved: 0,
        returned: 0,
        modificationRequested: 0,
      };
      reviewer.reviews += 1;
      if (row.decision === 'approved') reviewer.approved += 1;
      if (row.decision === 'return_for_completion') reviewer.returned += 1;
      if (row.decision === 'request_modification') reviewer.modificationRequested += 1;
      reviewerMap.set(reviewerKey, reviewer);
    }

    if (reviewHoursCount) {
      summary.averageReviewHours = Number((reviewHoursTotal / reviewHoursCount).toFixed(1));
    }

    const employees = [...employeeMap.values()]
      .map((item) => ({
        ...item,
        reworkCount: item.returned + item.modificationRequested,
        approvalRate: item.reviews
          ? Number(((item.approved / item.reviews) * 100).toFixed(1))
          : null,
      }))
      .sort((a, b) =>
        (b.reworkCount - a.reworkCount) ||
        (b.reviews - a.reviews)
      );

    const reviewers = [...reviewerMap.values()]
      .sort((a, b) => b.reviews - a.reviews);

    res.json({
      generatedAt: new Date(),
      periodDays,
      summary,
      employees,
      reviewers,
      items: rows,
      total,
      page,
      pageSize,
      totalPages: total ? Math.ceil(total / pageSize) : 0,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/directives/improvement-plans/effectiveness', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'تحليل فعالية خطط التحسين متاح للمستخدم الإشرافي فقط' });
    }

    const rawPeriod = String(req.query.periodDays || '180').trim().toLowerCase();
    const periodDays = rawPeriod === 'all'
      ? null
      : Math.min(730, Math.max(30, Number.parseInt(rawPeriod, 10) || 180));
    const now = new Date();
    const from = periodDays ? new Date(now.getTime() - periodDays * 86400000) : null;
    const cohortWhere = from
      ? {
          OR: [
            { createdAt: { gte: from } },
            { verifiedAt: { gte: from } },
            { completedAt: { gte: from } },
          ],
        }
      : {};

    const [plans, allPlans] = await Promise.all([
      prisma.transactionFollowUpImprovementPlan.findMany({
        where: cohortWhere,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.transactionFollowUpImprovementPlan.findMany({
        select: {
          id: true,
          metricKey: true,
          scopeType: true,
          assigneeUserId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const verifiedPlans = plans.filter(
      (plan) => plan.verifiedAt && plan.resultMetTarget !== null && plan.resultMetTarget !== undefined,
    );
    const successfulPlans = verifiedPlans.filter((plan) => plan.resultMetTarget === true);
    const unsuccessfulPlans = verifiedPlans.filter((plan) => plan.resultMetTarget === false);
    const openPlans = plans.filter((plan) => ['open', 'in_progress', 'monitoring'].includes(plan.status));
    const overduePlans = openPlans.filter((plan) => new Date(plan.dueDate).getTime() < now.getTime());

    const average = (values) =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const rounded = (value, digits = 1) =>
      value == null ? null : Number(value.toFixed(digits));

    const recoveryDays = successfulPlans
      .filter((plan) => plan.completedAt)
      .map((plan) =>
        Math.max(
          0,
          (new Date(plan.completedAt).getTime() - new Date(plan.createdAt).getTime()) / 86400000,
        )
      );

    const improvementPercentages = verifiedPlans.flatMap((plan) => {
      if (
        plan.baselineValue == null ||
        plan.resultValue == null ||
        Number(plan.baselineValue) === 0
      ) {
        return [];
      }
      const baseline = Number(plan.baselineValue);
      const result = Number(plan.resultValue);
      const directionalGain = plan.direction === 'min'
        ? result - baseline
        : baseline - result;
      return [(directionalGain / Math.abs(baseline)) * 100];
    });

    const recurrenceWindowDays = 90;
    const recurrenceWindowMs = recurrenceWindowDays * 86400000;
    const recurrenceMaturePlans = successfulPlans.filter(
      (plan) =>
        plan.completedAt &&
        now.getTime() - new Date(plan.completedAt).getTime() >= recurrenceWindowMs,
    );

    const hasRecurrence = (plan) => {
      if (!plan.completedAt) return false;
      const completedAt = new Date(plan.completedAt).getTime();
      const windowEnd = completedAt + recurrenceWindowMs;
      return allPlans.some((candidate) => {
        if (candidate.id === plan.id) return false;
        if (candidate.metricKey !== plan.metricKey || candidate.scopeType !== plan.scopeType) return false;
        if (plan.scopeType === 'employee' && candidate.assigneeUserId !== plan.assigneeUserId) return false;
        const createdAt = new Date(candidate.createdAt).getTime();
        return createdAt > completedAt && createdAt <= windowEnd;
      });
    };

    const recurrenceCount = recurrenceMaturePlans.filter(hasRecurrence).length;
    const recurrenceRate90d = recurrenceMaturePlans.length
      ? rounded((recurrenceCount / recurrenceMaturePlans.length) * 100)
      : null;

    const normalizePhrase = (value) =>
      String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const groupText = (field) => {
      const map = new Map();
      for (const plan of plans) {
        const text = String(plan[field] || '').trim();
        if (!text) continue;
        const key = normalizePhrase(text);
        const current = map.get(key) || {
          text,
          plans: 0,
          verified: 0,
          successful: 0,
          open: 0,
          recoveryDays: [],
        };
        current.plans += 1;
        if (plan.verifiedAt && plan.resultMetTarget !== null && plan.resultMetTarget !== undefined) {
          current.verified += 1;
          if (plan.resultMetTarget === true) current.successful += 1;
        }
        if (['open', 'in_progress', 'monitoring'].includes(plan.status)) current.open += 1;
        if (plan.resultMetTarget === true && plan.completedAt) {
          current.recoveryDays.push(
            Math.max(
              0,
              (new Date(plan.completedAt).getTime() - new Date(plan.createdAt).getTime()) / 86400000,
            ),
          );
        }
        map.set(key, current);
      }

      return [...map.values()]
        .map((item) => ({
          text: item.text,
          plans: item.plans,
          verified: item.verified,
          successful: item.successful,
          open: item.open,
          effectivenessRate: item.verified
            ? rounded((item.successful / item.verified) * 100)
            : null,
          avgRecoveryDays: rounded(average(item.recoveryDays)),
        }))
        .sort((a, b) =>
          (b.plans - a.plans) ||
          ((b.effectivenessRate ?? -1) - (a.effectivenessRate ?? -1))
        )
        .slice(0, 8);
    };

    const metricBreakdown = Object.entries(KPI_METRIC_LABELS).map(([metricKey, metricLabel]) => {
      const metricPlans = plans.filter((plan) => plan.metricKey === metricKey);
      const metricVerified = metricPlans.filter(
        (plan) => plan.verifiedAt && plan.resultMetTarget !== null && plan.resultMetTarget !== undefined,
      );
      const metricSuccessful = metricVerified.filter((plan) => plan.resultMetTarget === true);
      const metricRecoveryDays = metricSuccessful
        .filter((plan) => plan.completedAt)
        .map((plan) =>
          Math.max(
            0,
            (new Date(plan.completedAt).getTime() - new Date(plan.createdAt).getTime()) / 86400000,
          )
        );
      const mature = metricSuccessful.filter(
        (plan) =>
          plan.completedAt &&
          now.getTime() - new Date(plan.completedAt).getTime() >= recurrenceWindowMs,
      );
      const repeated = mature.filter(hasRecurrence).length;

      return {
        metricKey,
        metricLabel,
        plans: metricPlans.length,
        verified: metricVerified.length,
        successful: metricSuccessful.length,
        effectivenessRate: metricVerified.length
          ? rounded((metricSuccessful.length / metricVerified.length) * 100)
          : null,
        avgRecoveryDays: rounded(average(metricRecoveryDays)),
        recurrenceRate90d: mature.length
          ? rounded((repeated / mature.length) * 100)
          : null,
      };
    });

    const ownerMap = new Map();
    for (const plan of plans) {
      const key = plan.ownerUserId || 'unassigned';
      const item = ownerMap.get(key) || {
        userId: plan.ownerUserId || null,
        username: plan.ownerName || 'غير محدد',
        plans: 0,
        open: 0,
        overdue: 0,
        verified: 0,
        successful: 0,
        recoveryDays: [],
      };
      item.plans += 1;
      if (['open', 'in_progress', 'monitoring'].includes(plan.status)) item.open += 1;
      if (
        ['open', 'in_progress', 'monitoring'].includes(plan.status) &&
        new Date(plan.dueDate).getTime() < now.getTime()
      ) {
        item.overdue += 1;
      }
      if (plan.verifiedAt && plan.resultMetTarget !== null && plan.resultMetTarget !== undefined) {
        item.verified += 1;
        if (plan.resultMetTarget === true) item.successful += 1;
      }
      if (plan.resultMetTarget === true && plan.completedAt) {
        item.recoveryDays.push(
          Math.max(
            0,
            (new Date(plan.completedAt).getTime() - new Date(plan.createdAt).getTime()) / 86400000,
          ),
        );
      }
      ownerMap.set(key, item);
    }

    const owners = [...ownerMap.values()]
      .map((item) => ({
        userId: item.userId,
        username: item.username,
        plans: item.plans,
        open: item.open,
        overdue: item.overdue,
        verified: item.verified,
        successful: item.successful,
        effectivenessRate: item.verified
          ? rounded((item.successful / item.verified) * 100)
          : null,
        avgRecoveryDays: rounded(average(item.recoveryDays)),
      }))
      .sort((a, b) =>
        (b.overdue - a.overdue) ||
        (b.plans - a.plans)
      );

    const monthCount = 6;
    const monthlyTrend = [];
    for (let offset = monthCount - 1; offset >= 0; offset -= 1) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1);
      const created = plans.filter((plan) => {
        const value = new Date(plan.createdAt);
        return value >= monthStart && value < monthEnd;
      }).length;
      const verified = plans.filter((plan) => {
        if (!plan.verifiedAt) return false;
        const value = new Date(plan.verifiedAt);
        return value >= monthStart && value < monthEnd;
      }).length;
      const successful = plans.filter((plan) => {
        if (!plan.completedAt || plan.resultMetTarget !== true) return false;
        const value = new Date(plan.completedAt);
        return value >= monthStart && value < monthEnd;
      }).length;
      monthlyTrend.push({
        key: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`,
        year: monthStart.getFullYear(),
        month: monthStart.getMonth() + 1,
        created,
        verified,
        successful,
      });
    }

    res.json({
      generatedAt: now,
      periodDays,
      recurrenceWindowDays,
      summary: {
        plans: plans.length,
        open: openPlans.length,
        overdue: overduePlans.length,
        verified: verifiedPlans.length,
        successful: successfulPlans.length,
        unsuccessful: unsuccessfulPlans.length,
        effectivenessRate: verifiedPlans.length
          ? rounded((successfulPlans.length / verifiedPlans.length) * 100)
          : null,
        avgRecoveryDays: rounded(average(recoveryDays)),
        avgImprovementPercent: rounded(average(improvementPercentages)),
        recurrenceEligible: recurrenceMaturePlans.length,
        recurrenceCount,
        recurrenceRate90d,
        sustainedSuccessRate90d: recurrenceRate90d == null
          ? null
          : rounded(100 - recurrenceRate90d),
      },
      metricBreakdown,
      topRootCauses: groupText('rootCause'),
      topCorrectiveActions: groupText('correctiveAction'),
      owners,
      monthlyTrend,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/directives/risks', async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const level = String(req.query.level || '').trim();
    const category = String(req.query.category || '').trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(10, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));
    const supervisor = isSupervisor(req);
    const currentUserId = req.authUser?.id;
    const visibility = supervisor
      ? {}
      : {
          OR: [
            { ownerUserId: currentUserId },
            { assigneeUserId: currentUserId },
          ],
        };
    const filters = {
      ...visibility,
      ...(['open', 'monitoring', 'controlled', 'accepted', 'closed'].includes(status) ? { status } : {}),
      ...(['low', 'medium', 'high', 'critical'].includes(level) ? { residualLevel: level } : {}),
      ...(category ? { category } : {}),
    };
    const activeVisibility = {
      ...visibility,
      status: { not: 'closed' },
    };
    const now = new Date();

    const [
      total,
      items,
      active,
      highCritical,
      controlled,
      overdueReview,
      riskRows,
      categories,
    ] = await Promise.all([
      prisma.transactionFollowUpRiskRegister.count({ where: filters }),
      prisma.transactionFollowUpRiskRegister.findMany({
        where: filters,
        include: { events: { orderBy: { createdAt: 'desc' }, take: 10 } },
        orderBy: [{ residualScore: 'desc' }, { reviewDate: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.transactionFollowUpRiskRegister.count({ where: activeVisibility }),
      prisma.transactionFollowUpRiskRegister.count({
        where: { ...activeVisibility, residualLevel: { in: ['high', 'critical'] } },
      }),
      prisma.transactionFollowUpRiskRegister.count({
        where: { ...visibility, status: 'controlled' },
      }),
      prisma.transactionFollowUpRiskRegister.count({
        where: {
          ...activeVisibility,
          reviewDate: { lt: now },
        },
      }),
      prisma.transactionFollowUpRiskRegister.findMany({
        where: activeVisibility,
        select: { residualScore: true, residualLevel: true, residualProbability: true, residualImpact: true },
      }),
      prisma.transactionFollowUpRiskRegister.groupBy({
        by: ['category'],
        where: activeVisibility,
        _count: { _all: true },
        orderBy: { _count: { category: 'desc' } },
      }),
    ]);

    const averageResidualScore = riskRows.length
      ? Math.round((riskRows.reduce((sum, row) => sum + row.residualScore, 0) / riskRows.length) * 10) / 10
      : null;
    const levels = ['low', 'medium', 'high', 'critical'].map((riskLevel) => ({
      level: riskLevel,
      count: riskRows.filter((row) => row.residualLevel === riskLevel).length,
    }));
    const matrix = [];
    for (let impact = 5; impact >= 1; impact -= 1) {
      for (let probability = 1; probability <= 5; probability += 1) {
        matrix.push({
          probability,
          impact,
          count: riskRows.filter(
            (row) => row.residualProbability === probability && row.residualImpact === impact
          ).length,
        });
      }
    }

    res.json({
      generatedAt: now,
      supervisor,
      summary: {
        active,
        highCritical,
        controlled,
        overdueReview,
        averageResidualScore,
      },
      levels,
      matrix,
      categories: categories.map((row) => ({ category: row.category, count: row._count._all })),
      items: items.map(serializeRisk),
      total,
      page,
      pageSize,
      totalPages: total ? Math.ceil(total / pageSize) : 0,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/directives/risks', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'إنشاء سجل المخاطر متاح للمستخدم الإشرافي فقط' });
    }

    const input = riskRegisterCreateSchema.parse(req.body);
    const owner = await resolveAssignee(input.ownerUserId);
    let assignee = input.assigneeUserId ? await resolveAssignee(input.assigneeUserId) : null;
    let preventiveAction = null;

    if (input.sourcePreventiveActionId) {
      preventiveAction = await prisma.transactionFollowUpPreventiveAction.findUnique({
        where: { id: input.sourcePreventiveActionId },
      });
      if (!preventiveAction) {
        return res.status(404).json({ message: 'التدخل الوقائي المرتبط غير موجود' });
      }
      if (preventiveAction.riskRegisterId) {
        return res.status(409).json({ message: 'تم تسجيل هذا التدخل الوقائي مسبقًا في سجل المخاطر' });
      }
      if (!assignee && preventiveAction.assigneeUserId) {
        assignee = await resolveAssignee(preventiveAction.assigneeUserId);
      }
    }

    const probability = input.probability;
    const impact = input.impact;
    const residualProbability = input.residualProbability ?? probability;
    const residualImpact = input.residualImpact ?? impact;
    const inherentScore = riskMatrixScore(probability, impact);
    const residualScore = riskMatrixScore(residualProbability, residualImpact);
    const createdBy = actor(req);
    const riskNumber = await nextRiskNumber();
    const metricKey = input.metricKey || preventiveAction?.metricKey || null;
    const metricLabel = metricKey ? KPI_METRIC_LABELS[metricKey] : preventiveAction?.metricLabel || null;
    const sourceImprovementPlanId =
      input.sourceImprovementPlanId || preventiveAction?.improvementPlanId || null;

    const risk = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpRiskRegister.create({
        data: {
          riskNumber,
          title: input.title,
          description: input.description,
          category: input.category,
          sourceType: input.sourceType,
          metricKey,
          metricLabel,
          scopeType: input.scopeType,
          assigneeUserId: assignee?.id || null,
          assigneeName: assignee?.username || null,
          ownerUserId: owner.id,
          ownerName: owner.username,
          probability,
          impact,
          inherentScore,
          inherentLevel: riskMatrixLevelFromScore(inherentScore),
          controls: input.controls || [],
          treatmentStrategy: input.treatmentStrategy,
          treatmentPlan: input.treatmentPlan || null,
          residualProbability,
          residualImpact,
          residualScore,
          residualLevel: riskMatrixLevelFromScore(residualScore),
          reviewDate: input.reviewDate ? toDate(input.reviewDate, 'تاريخ المراجعة') : null,
          sourcePreventiveActionId: preventiveAction?.id || null,
          sourceImprovementPlanId,
          recurrenceCount: input.recurrenceCount || 0,
          lastOccurrenceAt: input.recurrenceCount ? new Date() : null,
          notes: input.notes || null,
          createdById: createdBy.id,
          createdByName: createdBy.name,
          updatedById: createdBy.id,
          updatedByName: createdBy.name,
          events: {
            create: {
              action: 'created',
              toStatus: 'open',
              probability,
              impact,
              residualProbability,
              residualImpact,
              residualScore,
              residualLevel: riskMatrixLevelFromScore(residualScore),
              note: preventiveAction
                ? 'إنشاء سجل خطر من تدخل وقائي'
                : 'إنشاء سجل خطر',
              changedById: createdBy.id,
              changedByName: createdBy.name,
            },
          },
        },
        include: { events: { orderBy: { createdAt: 'desc' } } },
      });

      if (preventiveAction) {
        await tx.transactionFollowUpPreventiveAction.update({
          where: { id: preventiveAction.id },
          data: {
            riskRegisterId: row.id,
            riskRegisteredAt: new Date(),
          },
        });
        await tx.transactionFollowUpPreventiveActionEvent.create({
          data: {
            actionId: preventiveAction.id,
            action: 'risk_registered',
            fromStatus: preventiveAction.status,
            toStatus: preventiveAction.status,
            note: `تم تسجيل الخطر ${riskNumber} في سجل المخاطر التشغيلية`,
            changedById: createdBy.id,
            changedByName: createdBy.name,
          },
        });
      }

      return row;
    });

    if (['high', 'critical'].includes(risk.residualLevel)) {
      const supervisorIds = await getFollowUpSupervisorIds();
      const recipients = new Set([risk.ownerUserId, ...supervisorIds].filter(Boolean));
      for (const userId of recipients) {
        await createFollowUpAlert({
          alertKey: `risk:${risk.id}:registered:${userId}`,
          transactionId: null,
          userId,
          kind: 'risk_registered_high',
          severity: risk.residualLevel === 'critical' ? 'danger' : 'warning',
          title: risk.residualLevel === 'critical' ? 'خطر تشغيلي حرج مسجل' : 'خطر تشغيلي مرتفع مسجل',
          message: `${risk.riskNumber} — ${risk.title}. درجة الخطر المتبقي ${risk.residualScore}/25.`,
        });
      }
    }

    res.status(201).json(serializeRisk(risk));
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/risks/:id', async (req, res, next) => {
  try {
    const input = riskRegisterUpdateSchema.parse(req.body);
    const current = await prisma.transactionFollowUpRiskRegister.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'سجل الخطر غير موجود' });

    const supervisor = isSupervisor(req);
    const ownsRisk = current.ownerUserId === req.authUser?.id;
    if (!supervisor && !ownsRisk) {
      return res.status(403).json({ message: 'لا يمكنك تحديث هذا الخطر' });
    }
    if (current.status === 'closed' && !supervisor) {
      return res.status(409).json({ message: 'لا يمكن تعديل خطر مغلق' });
    }
    if (!supervisor && (
      input.ownerUserId !== undefined ||
      input.title !== undefined ||
      input.description !== undefined ||
      input.category !== undefined ||
      input.probability !== undefined ||
      input.impact !== undefined ||
      input.status === 'closed' ||
      input.status === 'accepted'
    )) {
      return res.status(403).json({ message: 'تعديل بيانات الخطر الأساسية أو الإغلاق متاح للمستخدم الإشرافي فقط' });
    }

    const owner = supervisor && input.ownerUserId !== undefined
      ? (input.ownerUserId ? await resolveAssignee(input.ownerUserId) : null)
      : undefined;
    if (supervisor && input.ownerUserId !== undefined && !owner) {
      return res.status(400).json({ message: 'مالك الخطر مطلوب' });
    }

    const probability = input.probability ?? current.probability;
    const impact = input.impact ?? current.impact;
    const residualProbability = input.residualProbability ?? current.residualProbability;
    const residualImpact = input.residualImpact ?? current.residualImpact;
    const inherentScore = riskMatrixScore(probability, impact);
    const residualScore = riskMatrixScore(residualProbability, residualImpact);
    const residualLevel = riskLevelFromScore(residualScore);
    const changedBy = actor(req);
    const nextStatus = input.status || current.status;
    const recurrenceCount = input.recurrenceCount ?? current.recurrenceCount;
    const residualChanged =
      residualProbability !== current.residualProbability ||
      residualImpact !== current.residualImpact;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpRiskRegister.update({
        where: { id: current.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(owner !== undefined ? { ownerUserId: owner.id, ownerName: owner.username } : {}),
          probability,
          impact,
          inherentScore,
          inherentLevel: riskMatrixLevelFromScore(inherentScore),
          ...(input.controls !== undefined ? { controls: input.controls } : {}),
          ...(input.treatmentStrategy !== undefined ? { treatmentStrategy: input.treatmentStrategy } : {}),
          ...(input.treatmentPlan !== undefined ? { treatmentPlan: input.treatmentPlan || null } : {}),
          residualProbability,
          residualImpact,
          residualScore,
          residualLevel,
          ...(input.reviewDate !== undefined
            ? { reviewDate: input.reviewDate ? toDate(input.reviewDate, 'تاريخ المراجعة') : null }
            : {}),
          ...(input.status !== undefined
            ? {
                status: input.status,
                closedAt: input.status === 'closed' ? new Date() : current.closedAt,
              }
            : {}),
          recurrenceCount,
          ...(recurrenceCount > current.recurrenceCount ? { lastOccurrenceAt: new Date() } : {}),
          ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
          updatedById: changedBy.id,
          updatedByName: changedBy.name,
        },
      });

      await tx.transactionFollowUpRiskRegisterEvent.create({
        data: {
          riskId: current.id,
          action: residualChanged
            ? 'reassessed'
            : nextStatus !== current.status
              ? 'status_changed'
              : 'updated',
          fromStatus: current.status,
          toStatus: nextStatus,
          probability,
          impact,
          residualProbability,
          residualImpact,
          residualScore,
          residualLevel,
          note: input.notes || null,
          changedById: changedBy.id,
          changedByName: changedBy.name,
        },
      });

      return row;
    });

    if (['high', 'critical'].includes(updated.residualLevel) && (
      updated.residualLevel !== current.residualLevel || residualChanged
    )) {
      const supervisorIds = await getFollowUpSupervisorIds();
      const recipients = new Set([updated.ownerUserId, ...supervisorIds].filter(Boolean));
      for (const userId of recipients) {
        await createFollowUpAlert({
          alertKey: `risk:${updated.id}:reassessed:${saudiDayKey()}:${userId}`,
          transactionId: null,
          userId,
          kind: 'risk_reassessed_high',
          severity: updated.residualLevel === 'critical' ? 'danger' : 'warning',
          title: 'تحديث تقييم خطر تشغيلي',
          message: `${updated.riskNumber} — ${updated.title}. الخطر المتبقي ${updated.residualScore}/25 (${updated.residualLevel}).`,
        });
      }
    }

    res.json(serializeRisk(updated));
  } catch (error) {
    next(error);
  }
});

router.get('/directives/preventive-actions', async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const metricKey = String(req.query.metricKey || '').trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(10, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));
    const supervisor = isSupervisor(req);
    const currentUserId = req.authUser?.id;
    const visibility = supervisor
      ? {}
      : {
          OR: [
            { ownerUserId: currentUserId },
            { assigneeUserId: currentUserId },
          ],
        };
    const filters = {
      ...visibility,
      ...(['open', 'in_progress', 'monitoring', 'effective', 'failed', 'cancelled'].includes(status) ? { status } : {}),
      ...(Object.keys(KPI_METRIC_LABELS).includes(metricKey) ? { metricKey } : {}),
    };
    const now = new Date();

    const [total, items, openCount, overdueCount, monitoringCount, effective30d, failedCount] = await Promise.all([
      prisma.transactionFollowUpPreventiveAction.count({ where: filters }),
      prisma.transactionFollowUpPreventiveAction.findMany({
        where: filters,
        include: { events: { orderBy: { createdAt: 'desc' }, take: 12 } },
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.transactionFollowUpPreventiveAction.count({
        where: { ...visibility, status: { in: ['open', 'in_progress', 'monitoring'] } },
      }),
      prisma.transactionFollowUpPreventiveAction.count({
        where: {
          ...visibility,
          status: { in: ['open', 'in_progress', 'monitoring'] },
          dueDate: { lt: now },
        },
      }),
      prisma.transactionFollowUpPreventiveAction.count({ where: { ...visibility, status: 'monitoring' } }),
      prisma.transactionFollowUpPreventiveAction.count({
        where: {
          ...visibility,
          status: 'effective',
          completedAt: { gte: new Date(now.getTime() - 30 * 86400000) },
        },
      }),
      prisma.transactionFollowUpPreventiveAction.count({ where: { ...visibility, status: 'failed' } }),
    ]);

    res.json({
      generatedAt: now,
      supervisor,
      summary: {
        open: openCount,
        overdue: overdueCount,
        monitoring: monitoringCount,
        effective30d,
        failed: failedCount,
      },
      items: items.map((item) => ({
        ...item,
        isOverdue:
          ['open', 'in_progress', 'monitoring'].includes(item.status) &&
          new Date(item.dueDate).getTime() < now.getTime(),
      })),
      total,
      page,
      pageSize,
      totalPages: total ? Math.ceil(total / pageSize) : 0,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/directives/preventive-actions', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'إنشاء التدخلات الوقائية متاح للمستخدم الإشرافي فقط' });
    }

    const input = preventiveActionCreateSchema.parse(req.body);
    if (input.sourceType === 'metric' && !input.metricKey) {
      return res.status(400).json({ message: 'حدد المؤشر المرتبط بالإنذار المبكر' });
    }
    if (input.scopeType === 'employee' && !input.assigneeUserId) {
      return res.status(400).json({ message: 'حدد الموظف المرتبط بالتدخل الوقائي' });
    }

    const assignee = input.assigneeUserId ? await resolveAssignee(input.assigneeUserId) : null;
    const owner = await resolveAssignee(input.ownerUserId);
    const dueDate = toDate(input.dueDate, 'تاريخ الاستحقاق');
    const createdBy = actor(req);
    const metricLabel = input.metricKey ? KPI_METRIC_LABELS[input.metricKey] : null;

    const action = await prisma.transactionFollowUpPreventiveAction.create({
      data: {
        sourceType: input.sourceType,
        metricKey: input.metricKey || null,
        metricLabel,
        scopeType: input.scopeType,
        assigneeUserId: assignee?.id || null,
        assigneeName: assignee?.username || null,
        ownerUserId: owner.id,
        ownerName: owner.username,
        actionText: input.actionText,
        expectedOutcome: input.expectedOutcome || null,
        periodDays: input.periodDays,
        baselineValue: input.baselineValue ?? null,
        projectedValue: input.projectedValue ?? null,
        targetValue: input.targetValue ?? null,
        direction: input.direction || null,
        sourceRiskScore: input.sourceRiskScore ?? null,
        sourceRiskLevel: input.sourceRiskLevel || null,
        sourceReasons: input.sourceReasons || [],
        dueDate,
        createdById: createdBy.id,
        createdByName: createdBy.name,
        events: {
          create: {
            action: 'created',
            toStatus: 'open',
            note: 'إنشاء تدخل وقائي من شاشة الإنذار المبكر',
            changedById: createdBy.id,
            changedByName: createdBy.name,
          },
        },
      },
      include: { events: { orderBy: { createdAt: 'desc' } } },
    });

    await createFollowUpAlert({
      alertKey: `preventive:${action.id}:assigned:${owner.id}`,
      transactionId: null,
      userId: owner.id,
      kind: 'preventive_action_assigned',
      severity: 'warning',
      title: 'تكليف بإجراء وقائي',
      message: `${metricLabel ? `مؤشر «${metricLabel}»` : assignee?.username ? `مخاطر تشغيلية مرتبطة بـ ${assignee.username}` : 'تدخل وقائي'} — الاستحقاق ${saudiDayKey(dueDate)}.`,
    });

    res.status(201).json(action);
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/preventive-actions/:id', async (req, res, next) => {
  try {
    const input = preventiveActionUpdateSchema.parse(req.body);
    const current = await prisma.transactionFollowUpPreventiveAction.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'التدخل الوقائي غير موجود' });

    const supervisor = isSupervisor(req);
    const ownsAction = current.ownerUserId === req.authUser?.id;
    if (!supervisor && !ownsAction) {
      return res.status(403).json({ message: 'لا يمكنك تحديث هذا التدخل الوقائي' });
    }
    if (['effective', 'failed', 'cancelled'].includes(current.status)) {
      return res.status(409).json({ message: 'لا يمكن تعديل تدخل وقائي مغلق' });
    }

    if (!supervisor && (
      input.ownerUserId !== undefined ||
      input.actionText !== undefined ||
      input.expectedOutcome !== undefined ||
      input.dueDate !== undefined ||
      input.status === 'cancelled'
    )) {
      return res.status(403).json({ message: 'يمكن لمسؤول التنفيذ تحديث حالة التنفيذ والملاحظات فقط' });
    }

    const owner = supervisor && input.ownerUserId !== undefined
      ? (input.ownerUserId ? await resolveAssignee(input.ownerUserId) : null)
      : undefined;
    if (supervisor && input.ownerUserId !== undefined && !owner) {
      return res.status(400).json({ message: 'مسؤول التنفيذ مطلوب' });
    }

    const changedBy = actor(req);
    const nextStatus = input.status || current.status;
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpPreventiveAction.update({
        where: { id: current.id },
        data: {
          ...(input.progressNote !== undefined ? { progressNote: input.progressNote || null } : {}),
          ...(input.actionText !== undefined ? { actionText: input.actionText } : {}),
          ...(input.expectedOutcome !== undefined ? { expectedOutcome: input.expectedOutcome || null } : {}),
          ...(input.dueDate !== undefined ? { dueDate: toDate(input.dueDate, 'تاريخ الاستحقاق') } : {}),
          ...(owner !== undefined ? { ownerUserId: owner.id, ownerName: owner.username } : {}),
          ...(input.status ? {
            status: input.status,
            cancelledAt: input.status === 'cancelled' ? new Date() : current.cancelledAt,
          } : {}),
        },
      });
      await tx.transactionFollowUpPreventiveActionEvent.create({
        data: {
          actionId: current.id,
          action: nextStatus !== current.status ? 'status_changed' : 'updated',
          fromStatus: current.status,
          toStatus: nextStatus,
          note: input.progressNote || null,
          changedById: changedBy.id,
          changedByName: changedBy.name,
        },
      });
      return row;
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/preventive-actions/:id/verify', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'قياس أثر التدخل الوقائي متاح للمستخدم الإشرافي فقط' });
    }

    const current = await prisma.transactionFollowUpPreventiveAction.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'التدخل الوقائي غير موجود' });
    if (current.status === 'cancelled') {
      return res.status(409).json({ message: 'لا يمكن قياس تدخل وقائي ملغى' });
    }
    if (current.status === 'effective') {
      return res.json({ ...current, verification: { effective: true, capaRecommended: false } });
    }

    const now = new Date();
    const dueReached = new Date(current.dueDate).getTime() <= now.getTime();
    const changedBy = actor(req);
    let resultValue = null;
    let resultRiskScore = null;
    let resultStatus = null;
    let metTarget = false;

    if (current.metricKey) {
      if (current.targetValue == null || !current.direction) {
        return res.status(409).json({ message: 'بيانات المستهدف غير مكتملة لهذا التدخل الوقائي' });
      }
      const snapshot = await calculateCurrentKpiSnapshot(
        current.periodDays,
        current.scopeType === 'employee' ? current.assigneeUserId : null,
      );
      resultValue = snapshot[current.metricKey];
      if (resultValue == null) {
        return res.status(409).json({ message: 'لا توجد بيانات كافية لقياس أثر التدخل الوقائي' });
      }
      const evaluation = evaluateMetric(resultValue, current.targetValue, current.direction, 0);
      resultStatus = evaluation.status;
      metTarget = evaluation.met === true;
    } else if (current.scopeType === 'employee' && current.assigneeUserId) {
      const warning = await buildEarlyWarningSnapshot(current.periodDays);
      const employee = warning.employees.find((item) => item.userId === current.assigneeUserId);
      resultRiskScore = employee?.riskScore ?? 0;
      resultStatus = employee?.riskLevel || 'low';
      metTarget = !employee || !['critical', 'high'].includes(employee.riskLevel);
    } else {
      return res.status(409).json({ message: 'لا توجد آلية قياس محددة لهذا التدخل الوقائي' });
    }

    const nextStatus = metTarget ? 'effective' : dueReached ? 'failed' : 'monitoring';
    const note = metTarget
      ? 'حقق التدخل الوقائي الأثر المطلوب قبل الحاجة إلى CAPA'
      : nextStatus === 'failed'
        ? 'لم يحقق التدخل الوقائي الأثر المطلوب عند الاستحقاق ويوصى بفتح CAPA'
        : 'تم القياس وما زال التدخل الوقائي تحت المراقبة حتى موعد الاستحقاق';

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpPreventiveAction.update({
        where: { id: current.id },
        data: {
          status: nextStatus,
          progressNote: note,
          resultValue,
          resultRiskScore,
          resultStatus,
          resultMetTarget: metTarget,
          verifiedAt: now,
          verifiedById: changedBy.id,
          verifiedByName: changedBy.name,
          completedAt: metTarget ? now : null,
          failedAt: nextStatus === 'failed' ? now : null,
        },
      });
      await tx.transactionFollowUpPreventiveActionEvent.create({
        data: {
          actionId: current.id,
          action: 'verified',
          fromStatus: current.status,
          toStatus: nextStatus,
          note,
          resultValue,
          resultRiskScore,
          resultStatus,
          resultMetTarget: metTarget,
          changedById: changedBy.id,
          changedByName: changedBy.name,
        },
      });
      return row;
    });

    if (nextStatus === 'failed') {
      const supervisorIds = await getFollowUpSupervisorIds();
      for (const supervisorId of supervisorIds) {
        await createFollowUpAlert({
          alertKey: `preventive:${current.id}:failed:${saudiDayKey(now)}:${supervisorId}`,
          transactionId: null,
          userId: supervisorId,
          kind: 'preventive_action_failed',
          severity: 'danger',
          title: 'فشل تدخل وقائي — CAPA مطلوبة',
          message: `${current.metricLabel ? `مؤشر «${current.metricLabel}»` : current.assigneeName || 'التدخل الوقائي'} لم يحقق الأثر المطلوب عند الاستحقاق.`,
        });
      }
    }

    res.json({
      ...updated,
      verification: {
        resultValue,
        resultRiskScore,
        resultStatus,
        metTarget,
        effective: metTarget,
        capaRecommended: nextStatus === 'failed' && !updated.improvementPlanId,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/directives/preventive-actions/:id/link-capa', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'ربط CAPA متاح للمستخدم الإشرافي فقط' });
    }
    const input = preventiveActionLinkCapaSchema.parse(req.body);
    const current = await prisma.transactionFollowUpPreventiveAction.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'التدخل الوقائي غير موجود' });
    if (current.status !== 'failed') {
      return res.status(409).json({ message: 'لا يتم إنشاء CAPA إلا بعد فشل التدخل الوقائي' });
    }

    const plan = await prisma.transactionFollowUpImprovementPlan.findUnique({
      where: { id: input.improvementPlanId },
      select: { id: true },
    });
    if (!plan) return res.status(404).json({ message: 'خطة CAPA غير موجودة' });

    const changedBy = actor(req);
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpPreventiveAction.update({
        where: { id: current.id },
        data: { improvementPlanId: plan.id, escalatedAt: now },
      });
      await tx.transactionFollowUpPreventiveActionEvent.create({
        data: {
          actionId: current.id,
          action: 'capa_linked',
          fromStatus: current.status,
          toStatus: current.status,
          note: 'تم تصعيد التدخل الوقائي الفاشل إلى خطة CAPA',
          changedById: changedBy.id,
          changedByName: changedBy.name,
        },
      });
      return row;
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get('/directives/improvement-plans', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'خطط تحسين الأداء متاحة للمستخدم الإشرافي فقط' });
    }

    const status = String(req.query.status || '').trim();
    const metricKey = String(req.query.metricKey || '').trim();
    const assigneeUserId = String(req.query.assigneeUserId || '').trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(10, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));
    const now = new Date();

    const where = {
      ...(['open', 'in_progress', 'monitoring', 'completed', 'cancelled'].includes(status) ? { status } : {}),
      ...(Object.keys(KPI_METRIC_LABELS).includes(metricKey) ? { metricKey } : {}),
      ...(assigneeUserId ? { assigneeUserId } : {}),
    };

    const [total, items, openCount, overdueCount, monitoringCount, completed30d] = await Promise.all([
      prisma.transactionFollowUpImprovementPlan.count({ where }),
      prisma.transactionFollowUpImprovementPlan.findMany({
        where,
        include: { events: { orderBy: { createdAt: 'desc' }, take: 10 } },
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.transactionFollowUpImprovementPlan.count({
        where: { status: { in: ['open', 'in_progress', 'monitoring'] } },
      }),
      prisma.transactionFollowUpImprovementPlan.count({
        where: {
          status: { in: ['open', 'in_progress', 'monitoring'] },
          dueDate: { lt: now },
        },
      }),
      prisma.transactionFollowUpImprovementPlan.count({ where: { status: 'monitoring' } }),
      prisma.transactionFollowUpImprovementPlan.count({
        where: {
          status: 'completed',
          completedAt: { gte: new Date(now.getTime() - 30 * 86400000) },
        },
      }),
    ]);

    res.json({
      generatedAt: now,
      summary: {
        open: openCount,
        overdue: overdueCount,
        monitoring: monitoringCount,
        completed30d,
      },
      items: items.map((item) => ({
        ...item,
        isOverdue:
          ['open', 'in_progress', 'monitoring'].includes(item.status) &&
          new Date(item.dueDate).getTime() < now.getTime(),
      })),
      total,
      page,
      pageSize,
      totalPages: total ? Math.ceil(total / pageSize) : 0,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/directives/improvement-plans', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'إنشاء خطة تحسين متاح للمستخدم الإشرافي فقط' });
    }

    const input = improvementPlanCreateSchema.parse(req.body);
    if (input.scopeType === 'employee' && !input.assigneeUserId) {
      return res.status(400).json({ message: 'حدد الموظف المرتبط بخطة التحسين' });
    }

    const assignee = input.scopeType === 'employee'
      ? await resolveAssignee(input.assigneeUserId)
      : null;
    const owner = input.ownerUserId ? await resolveAssignee(input.ownerUserId) : null;
    const dueDate = toDate(input.dueDate, 'تاريخ الاستحقاق');
    const createdBy = actor(req);

    const plan = await prisma.transactionFollowUpImprovementPlan.create({
      data: {
        metricKey: input.metricKey,
        metricLabel: KPI_METRIC_LABELS[input.metricKey],
        scopeType: input.scopeType,
        assigneeUserId: assignee?.id || null,
        assigneeName: assignee?.username || null,
        baselineValue: input.baselineValue ?? null,
        targetValue: input.targetValue,
        direction: input.direction,
        periodDays: input.periodDays,
        rootCause: input.rootCause,
        correctiveAction: input.correctiveAction,
        preventiveAction: input.preventiveAction || null,
        ownerUserId: owner?.id || null,
        ownerName: owner?.username || null,
        dueDate,
        createdById: createdBy.id,
        createdByName: createdBy.name,
        events: {
          create: {
            action: 'created',
            toStatus: 'open',
            note: 'إنشاء خطة تحسين مرتبطة بمؤشر أداء',
            changedById: createdBy.id,
            changedByName: createdBy.name,
          },
        },
      },
      include: { events: { orderBy: { createdAt: 'desc' } } },
    });

    res.status(201).json(plan);
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/improvement-plans/:id', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'تحديث خطة التحسين متاح للمستخدم الإشرافي فقط' });
    }

    const input = improvementPlanUpdateSchema.parse(req.body);
    const current = await prisma.transactionFollowUpImprovementPlan.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'خطة التحسين غير موجودة' });

    const owner = input.ownerUserId !== undefined
      ? (input.ownerUserId ? await resolveAssignee(input.ownerUserId) : null)
      : undefined;
    const changedBy = actor(req);
    const nextStatus = input.status || current.status;
    const statusChanged = nextStatus !== current.status;
    const now = new Date();

    const data = {
      ...(input.rootCause !== undefined ? { rootCause: input.rootCause } : {}),
      ...(input.correctiveAction !== undefined ? { correctiveAction: input.correctiveAction } : {}),
      ...(input.preventiveAction !== undefined ? { preventiveAction: input.preventiveAction || null } : {}),
      ...(input.progressNote !== undefined ? { progressNote: input.progressNote || null } : {}),
      ...(input.dueDate !== undefined ? { dueDate: toDate(input.dueDate, 'تاريخ الاستحقاق') } : {}),
      ...(owner !== undefined ? {
        ownerUserId: owner?.id || null,
        ownerName: owner?.username || null,
      } : {}),
      ...(statusChanged ? {
        status: nextStatus,
        startedAt: nextStatus === 'in_progress' && !current.startedAt ? now : current.startedAt,
        monitoringAt: nextStatus === 'monitoring' ? now : current.monitoringAt,
        completedAt: nextStatus === 'completed' ? now : nextStatus !== 'completed' ? null : current.completedAt,
        cancelledAt: nextStatus === 'cancelled' ? now : nextStatus !== 'cancelled' ? null : current.cancelledAt,
      } : {}),
    };

    const [updated] = await prisma.$transaction([
      prisma.transactionFollowUpImprovementPlan.update({
        where: { id: current.id },
        data,
      }),
      prisma.transactionFollowUpImprovementPlanEvent.create({
        data: {
          planId: current.id,
          action: statusChanged ? 'status_changed' : 'updated',
          fromStatus: current.status,
          toStatus: nextStatus,
          note: input.progressNote || null,
          changedById: changedBy.id,
          changedByName: changedBy.name,
        },
      }),
    ]);

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/improvement-plans/:id/verify', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'التحقق من أثر خطة التحسين متاح للمستخدم الإشرافي فقط' });
    }

    const current = await prisma.transactionFollowUpImprovementPlan.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'خطة التحسين غير موجودة' });
    if (current.status === 'cancelled') {
      return res.status(409).json({ message: 'لا يمكن التحقق من خطة ملغاة' });
    }

    const snapshot = await calculateCurrentKpiSnapshot(
      current.periodDays,
      current.scopeType === 'employee' ? current.assigneeUserId : null,
    );
    const resultValue = snapshot[current.metricKey];
    if (resultValue == null) {
      return res.status(409).json({ message: 'لا توجد بيانات كافية للتحقق من أثر الخطة على المؤشر' });
    }

    const evaluation = evaluateMetric(resultValue, current.targetValue, current.direction, 0);
    const metTarget = evaluation.met === true;
    const changedBy = actor(req);
    const now = new Date();
    const nextStatus = metTarget ? 'completed' : 'monitoring';
    const note = metTarget
      ? 'تحقق أثر خطة التحسين وحقق المؤشر المستهدف'
      : 'تم القياس وما زال المؤشر بحاجة إلى متابعة';

    const [updated] = await prisma.$transaction([
      prisma.transactionFollowUpImprovementPlan.update({
        where: { id: current.id },
        data: {
          status: nextStatus,
          resultValue,
          resultMetTarget: metTarget,
          verifiedAt: now,
          verifiedById: changedBy.id,
          verifiedByName: changedBy.name,
          monitoringAt: metTarget ? current.monitoringAt : now,
          completedAt: metTarget ? now : null,
          progressNote: note,
        },
      }),
      prisma.transactionFollowUpImprovementPlanEvent.create({
        data: {
          planId: current.id,
          action: 'verified',
          fromStatus: current.status,
          toStatus: nextStatus,
          note,
          resultValue,
          resultMetTarget: metTarget,
          changedById: changedBy.id,
          changedByName: changedBy.name,
        },
      }),
    ]);

    res.json({
      ...updated,
      verification: {
        value: resultValue,
        target: current.targetValue,
        direction: current.direction,
        metTarget,
        status: evaluation.status,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/directives/early-warning', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'الإنذار المبكر متاح للمستخدم الإشرافي فقط' });
    }
    const requested = Number.parseInt(String(req.query.periodDays || '30'), 10) || 30;
    const periodDays = Math.min(90, Math.max(14, requested));
    res.json(await buildEarlyWarningSnapshot(periodDays));
  } catch (error) {
    next(error);
  }
});

router.get('/directives/kpi-targets', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'مستهدفات الأداء متاحة للمستخدم الإشرافي فقط' });
    }
    res.json(await getKpiTargets());
  } catch (error) {
    next(error);
  }
});

router.put('/directives/kpi-targets', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'تعديل مستهدفات الأداء متاح للمستخدم الإشرافي فقط' });
    }

    const input = kpiTargetSchema.parse(req.body);
    const changedBy = actor(req);
    const saved = await prisma.transactionFollowUpKpiTarget.upsert({
      where: { scope: 'global' },
      update: {
        ...input,
        updatedById: changedBy.id,
        updatedByName: changedBy.name,
      },
      create: {
        scope: 'global',
        ...input,
        updatedById: changedBy.id,
        updatedByName: changedBy.name,
      },
    });

    res.json(saved);
  } catch (error) {
    next(error);
  }
});

router.get('/directives/kpi', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'مؤشرات أداء التوجيهات متاحة للمستخدم الإشرافي فقط' });
    }

    const periodDaysRaw = String(req.query.periodDays || '90').trim();
    const periodDays = periodDaysRaw === 'all'
      ? null
      : Math.min(3650, Math.max(7, Number.parseInt(periodDaysRaw, 10) || 90));
    const assigneeUserId = String(req.query.assigneeUserId || '').trim();
    const now = new Date();
    const currentStart = periodDays ? new Date(now.getTime() - periodDays * 86400000) : null;
    const previousStart = periodDays ? new Date(now.getTime() - periodDays * 2 * 86400000) : null;
    const previousEnd = currentStart;

    const monthStarts = [];
    const monthCursor = new Date(now);
    monthCursor.setHours(0, 0, 0, 0);
    monthCursor.setDate(1);
    for (let index = 5; index >= 0; index -= 1) {
      monthStarts.push(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - index, 1));
    }
    const trendStart = monthStarts[0];
    const earliestReviewStart = previousStart && previousStart < trendStart ? previousStart : trendStart;

    const directiveWhere = {
      ...(assigneeUserId ? { assigneeUserId } : {}),
      reviews: periodDays
        ? { some: { reviewedAt: { gte: earliestReviewStart } } }
        : { some: {} },
    };

    const [directives, openRows, assigneeUsers] = await Promise.all([
      prisma.transactionFollowUpDirective.findMany({
        where: directiveWhere,
        select: {
          id: true,
          directiveType: true,
          title: true,
          assigneeUserId: true,
          assigneeName: true,
          priority: true,
          status: true,
          issuedAt: true,
          startedAt: true,
          dueDate: true,
          completedAt: true,
          reviews: {
            select: {
              id: true,
              decision: true,
              submittedAt: true,
              reviewedAt: true,
            },
            orderBy: { reviewedAt: 'asc' },
          },
        },
      }),
      prisma.transactionFollowUpDirective.findMany({
        where: {
          ...(assigneeUserId ? { assigneeUserId } : {}),
          status: { in: ['pending', 'in_progress', 'returned'] },
          dueDate: { not: null },
        },
        select: {
          id: true,
          assigneeUserId: true,
          assigneeName: true,
          status: true,
          priority: true,
          dueDate: true,
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

    const round = (value, digits = 1) =>
      value == null ? null : Number(value.toFixed(digits));
    const avg = (values) =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const inRange = (date, start, end) => {
      const time = new Date(date).getTime();
      return (!start || time >= start.getTime()) && (!end || time < end.getTime());
    };
    const isSubmittedOnTime = (submittedAt, dueDate) => {
      if (!submittedAt || !dueDate) return null;
      return dayNumberFromKey(saudiDayKey(new Date(submittedAt))) <=
        dayNumberFromKey(saudiDayKey(new Date(dueDate)));
    };

    const currentOverdueByEmployee = new Map();
    const currentOpenByEmployee = new Map();
    const currentUrgentOpenByEmployee = new Map();
    let currentOverdue = 0;
    let currentOpen = 0;
    let currentUrgentOpen = 0;

    for (const row of openRows) {
      currentOpen += 1;
      currentOpenByEmployee.set(
        row.assigneeUserId,
        (currentOpenByEmployee.get(row.assigneeUserId) || 0) + 1,
      );
      if (row.priority === 'urgent') {
        currentUrgentOpen += 1;
        currentUrgentOpenByEmployee.set(
          row.assigneeUserId,
          (currentUrgentOpenByEmployee.get(row.assigneeUserId) || 0) + 1,
        );
      }
      if (
        row.dueDate &&
        dayNumberFromKey(saudiDayKey(new Date(row.dueDate))) <
          dayNumberFromKey(saudiDayKey(now))
      ) {
        currentOverdue += 1;
        currentOverdueByEmployee.set(
          row.assigneeUserId,
          (currentOverdueByEmployee.get(row.assigneeUserId) || 0) + 1,
        );
      }
    }

    const summarize = (start, end, employeeId = null) => {
      const relevant = employeeId
        ? directives.filter((directive) => directive.assigneeUserId === employeeId)
        : directives;

      let reviewCount = 0;
      let approvedReviews = 0;
      let returnedReviews = 0;
      let modificationReviews = 0;
      let firstReviewCandidates = 0;
      let firstPassApproved = 0;
      let reviewedDirectiveCount = 0;
      let reworkDirectiveCount = 0;
      let approvedDirectiveCount = 0;
      let completedOnTime = 0;
      let completedWithDue = 0;
      const executionHours = [];
      const approvalHours = [];
      const reviewedDirectiveIds = new Set();

      for (const directive of relevant) {
        const periodReviews = directive.reviews.filter((review) => inRange(review.reviewedAt, start, end));
        if (!periodReviews.length) continue;

        reviewedDirectiveIds.add(directive.id);
        reviewedDirectiveCount += 1;
        let hasRework = false;
        let hasApproval = false;

        for (const review of periodReviews) {
          reviewCount += 1;
          if (review.decision === 'approved') {
            approvedReviews += 1;
            hasApproval = true;
            if (directive.dueDate && review.submittedAt) {
              completedWithDue += 1;
              if (isSubmittedOnTime(review.submittedAt, directive.dueDate)) completedOnTime += 1;
            }
          } else if (review.decision === 'return_for_completion') {
            returnedReviews += 1;
            hasRework = true;
          } else if (review.decision === 'request_modification') {
            modificationReviews += 1;
            hasRework = true;
          }

          if (review.submittedAt) {
            approvalHours.push(Math.max(
              0,
              (new Date(review.reviewedAt).getTime() - new Date(review.submittedAt).getTime()) / 3600000,
            ));
          }
        }

        if (hasRework) reworkDirectiveCount += 1;
        if (hasApproval) approvedDirectiveCount += 1;

        const firstReview = directive.reviews[0];
        if (firstReview && inRange(firstReview.reviewedAt, start, end)) {
          firstReviewCandidates += 1;
          if (firstReview.decision === 'approved') firstPassApproved += 1;
          if (firstReview.submittedAt) {
            executionHours.push(Math.max(
              0,
              (new Date(firstReview.submittedAt).getTime() - new Date(directive.issuedAt).getTime()) / 3600000,
            ));
          }
        }
      }

      return {
        reviewCount,
        reviewedDirectives: reviewedDirectiveCount,
        approvedDirectives: approvedDirectiveCount,
        approvedReviews,
        returnedReviews,
        modificationReviews,
        firstPassRate: firstReviewCandidates
          ? round((firstPassApproved / firstReviewCandidates) * 100, 1)
          : null,
        reworkRate: reviewedDirectiveCount
          ? round((reworkDirectiveCount / reviewedDirectiveCount) * 100, 1)
          : null,
        avgExecutionHours: round(avg(executionHours), 1),
        avgApprovalHours: round(avg(approvalHours), 1),
        onTimeRate: completedWithDue
          ? round((completedOnTime / completedWithDue) * 100, 1)
          : null,
      };
    };

    const currentSummaryBase = summarize(currentStart, null);
    const previousSummaryBase = periodDays ? summarize(previousStart, previousEnd) : null;
    const summary = {
      ...currentSummaryBase,
      openDirectives: currentOpen,
      overdueOpen: currentOverdue,
      urgentOpen: currentUrgentOpen,
    };
    const previousSummary = previousSummaryBase
      ? {
          ...previousSummaryBase,
          openDirectives: null,
          overdueOpen: null,
          urgentOpen: null,
        }
      : null;

    const employeeSeed = new Map(assigneeUsers.map((user) => [
      user.id,
      { userId: user.id, username: user.username },
    ]));
    directives.forEach((directive) => {
      if (!employeeSeed.has(directive.assigneeUserId)) {
        employeeSeed.set(directive.assigneeUserId, {
          userId: directive.assigneeUserId,
          username: directive.assigneeName || 'مستخدم',
        });
      }
    });

    const employees = [...employeeSeed.values()]
      .map((employee) => {
        const metrics = summarize(currentStart, null, employee.userId);
        return {
          ...employee,
          ...metrics,
          openDirectives: currentOpenByEmployee.get(employee.userId) || 0,
          overdueOpen: currentOverdueByEmployee.get(employee.userId) || 0,
          urgentOpen: currentUrgentOpenByEmployee.get(employee.userId) || 0,
        };
      })
      .filter((employee) =>
        employee.reviewCount ||
        employee.openDirectives ||
        employee.overdueOpen ||
        employee.urgentOpen
      )
      .sort((a, b) =>
        (b.overdueOpen - a.overdueOpen) ||
        ((b.reworkRate || 0) - (a.reworkRate || 0)) ||
        (b.reviewedDirectives - a.reviewedDirectives)
      );

    const monthlyTrend = monthStarts.map((start, index) => {
      const end = index < monthStarts.length - 1
        ? monthStarts[index + 1]
        : new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const metrics = summarize(start, end, assigneeUserId || null);
      return {
        key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
        year: start.getFullYear(),
        month: start.getMonth() + 1,
        ...metrics,
      };
    });

    const targets = await getKpiTargets();
    const evaluation = evaluateKpiMetrics(summary, targets);
    const employeesWithEvaluation = employees.map((employee) => ({
      ...employee,
      evaluation: evaluateKpiMetrics(employee, targets),
    }));

    res.json({
      generatedAt: now,
      periodDays,
      assigneeUserId: assigneeUserId || null,
      targets,
      evaluation,
      summary,
      previousSummary,
      employees: employeesWithEvaluation,
      monthlyTrend,
    });
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

router.post('/:id/directives', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'إصدار التوجيهات والقرارات متاح للمستخدم الإشرافي فقط' });
    }

    const input = directiveCreateSchema.parse(req.body);
    const transaction = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
      select: { id: true, transactionNumber: true, subject: true },
    });
    if (!transaction) return res.status(404).json({ message: 'المعاملة غير موجودة' });

    const assignee = await resolveAssignee(input.assigneeUserId);
    const issuedBy = actor(req);
    const dueDate = toDate(input.dueDate, 'تاريخ استحقاق التوجيه');
    const now = new Date();

    const directive = await prisma.transactionFollowUpDirective.create({
      data: {
        transactionId: transaction.id,
        directiveType: input.directiveType,
        title: input.title,
        instruction: input.instruction,
        priority: input.priority,
        status: 'pending',
        assigneeUserId: assignee.id,
        assigneeName: assignee.username,
        dueDate,
        issuedById: issuedBy.id,
        issuedByName: issuedBy.name,
        lastUpdatedById: issuedBy.id,
        lastUpdatedByName: issuedBy.name,
      },
    });

    await prisma.transactionFollowUpEvent.create({
      data: {
        transactionId: transaction.id,
        eventType: 'directive_created',
        toAssigneeUserId: assignee.id,
        toAssigneeName: assignee.username,
        actionText: `${input.directiveType === 'decision' ? 'إصدار قرار' : 'إصدار توجيه'}: ${input.title}`,
        note: input.instruction,
        createdById: issuedBy.id,
        createdByName: issuedBy.name,
      },
    });

    await createFollowUpAlert({
      alertKey: `directive:${directive.id}:assigned:${assignee.id}`,
      transactionId: transaction.id,
      userId: assignee.id,
      kind: 'directive_assigned',
      severity: input.priority === 'urgent' ? 'danger' : input.priority === 'high' ? 'warning' : 'info',
      title: input.directiveType === 'decision' ? 'تم إسناد قرار إداري إليك' : 'تم إسناد توجيه إداري إليك',
      message: `${input.title} — المعاملة ${transaction.transactionNumber}. ${dueDate ? `الاستحقاق: ${saudiDayKey(dueDate)}.` : ''}`,
    });

    res.status(201).json(serializeDirective(directive));
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/directives/:directiveId', async (req, res, next) => {
  try {
    const input = directiveUpdateSchema.parse(req.body);
    const directive = await prisma.transactionFollowUpDirective.findFirst({
      where: { id: req.params.directiveId, transactionId: req.params.id },
      include: {
        transaction: { select: { id: true, transactionNumber: true, subject: true } },
      },
    });
    if (!directive) return res.status(404).json({ message: 'التوجيه أو القرار غير موجود' });

    const supervisor = isSupervisor(req);
    if (!supervisor && directive.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'هذا التوجيه غير مسند إلى حسابك' });
    }
    if (input.status === 'cancelled' && !supervisor) {
      return res.status(403).json({ message: 'إلغاء التوجيه متاح للمستخدم الإشرافي فقط' });
    }
    if (input.status === 'awaiting_approval' && !input.completionResponse?.trim()) {
      return res.status(400).json({ message: 'اكتب نتيجة التنفيذ قبل رفعها للاعتماد' });
    }
    if (
      input.status === 'awaiting_approval' &&
      !['pending', 'in_progress', 'returned'].includes(directive.status)
    ) {
      return res.status(409).json({ message: 'حالة التوجيه الحالية لا تسمح برفع الإنجاز للاعتماد' });
    }
    if (input.status === 'in_progress' && !['pending', 'returned', 'in_progress'].includes(directive.status)) {
      return res.status(409).json({ message: 'حالة التوجيه الحالية لا تسمح ببدء أو استكمال التنفيذ' });
    }

    const changedBy = actor(req);
    const now = new Date();
    const submitting = input.status === 'awaiting_approval';
    const updated = await prisma.transactionFollowUpDirective.update({
      where: { id: directive.id },
      data: {
        status: input.status,
        ...(input.completionResponse !== undefined
          ? { completionResponse: input.completionResponse || null }
          : {}),
        ...(input.completionNote !== undefined
          ? { completionNote: input.completionNote || null }
          : {}),
        startedAt: input.status === 'in_progress'
          ? (directive.startedAt || now)
          : directive.startedAt,
        completionSubmittedAt: submitting ? now : directive.completionSubmittedAt,
        completionSubmittedById: submitting ? changedBy.id : directive.completionSubmittedById,
        completionSubmittedByName: submitting ? changedBy.name : directive.completionSubmittedByName,
        reviewDecision: submitting ? null : directive.reviewDecision,
        reviewNote: submitting ? null : directive.reviewNote,
        reviewedAt: submitting ? null : directive.reviewedAt,
        reviewedById: submitting ? null : directive.reviewedById,
        reviewedByName: submitting ? null : directive.reviewedByName,
        completedAt: null,
        lastUpdatedById: changedBy.id,
        lastUpdatedByName: changedBy.name,
      },
    });

    const actionLabel =
      input.status === 'in_progress'
        ? (directive.status === 'returned' ? 'استكمال تنفيذ التوجيه بعد إعادته' : 'بدء تنفيذ التوجيه')
        : input.status === 'awaiting_approval'
          ? 'رفع نتيجة تنفيذ التوجيه لاعتماد الإدارة'
          : input.status === 'cancelled'
            ? 'إلغاء التوجيه'
            : 'إعادة التوجيه إلى قائمة الانتظار';

    await prisma.transactionFollowUpEvent.create({
      data: {
        transactionId: directive.transactionId,
        eventType: input.status === 'awaiting_approval' ? 'directive_submitted_for_approval' : 'directive_updated',
        fromAssigneeUserId: directive.assigneeUserId,
        fromAssigneeName: directive.assigneeName,
        toAssigneeUserId: directive.assigneeUserId,
        toAssigneeName: directive.assigneeName,
        actionText: `${actionLabel}: ${directive.title}`,
        note: input.completionResponse || input.completionNote || null,
        createdById: changedBy.id,
        createdByName: changedBy.name,
      },
    });

    if (submitting) {
      const supervisorIds = await getFollowUpSupervisorIds();
      for (const supervisorId of supervisorIds) {
        if (supervisorId === req.authUser.id) continue;
        await createFollowUpAlert({
          alertKey: `directive:${directive.id}:awaiting_approval:${now.toISOString()}:${supervisorId}`,
          transactionId: directive.transactionId,
          userId: supervisorId,
          kind: 'directive_awaiting_approval',
          severity: directive.priority === 'urgent' ? 'danger' : 'info',
          title: 'إنجاز توجيه بانتظار اعتماد الإدارة',
          message: `${directive.title} — المعاملة ${directive.transaction.transactionNumber}. المنفذ: ${directive.assigneeName}.`,
        });
      }
    }

    res.json(serializeDirective(updated));
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/directives/:directiveId/review', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'اعتماد نتائج التوجيهات متاح للمستخدم الإشرافي فقط' });
    }

    const input = directiveReviewSchema.parse(req.body);
    const directive = await prisma.transactionFollowUpDirective.findFirst({
      where: { id: req.params.directiveId, transactionId: req.params.id },
      include: {
        transaction: { select: { id: true, transactionNumber: true, subject: true } },
      },
    });
    if (!directive) return res.status(404).json({ message: 'التوجيه أو القرار غير موجود' });
    if (directive.status !== 'awaiting_approval') {
      return res.status(409).json({ message: 'هذا التوجيه ليس بانتظار اعتماد نتيجة التنفيذ' });
    }
    if (input.decision !== 'approved' && !input.reviewNote?.trim()) {
      return res.status(400).json({ message: 'اكتب ملاحظة الإدارة عند إعادة التوجيه أو طلب التعديل' });
    }

    const reviewer = actor(req);
    const now = new Date();
    const approved = input.decision === 'approved';
    const nextStatus = approved ? 'completed' : 'returned';

    const evidence = await prisma.attachment.findMany({
      where: {
        entityType: 'transaction_follow_up_directive',
        entityId: directive.id,
      },
      select: {
        id: true,
        title: true,
        driveUrl: true,
        driveFileId: true,
        mimeType: true,
        notes: true,
        createdBy: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const decisionLabel =
      input.decision === 'approved'
        ? 'اعتماد نتيجة تنفيذ التوجيه'
        : input.decision === 'return_for_completion'
          ? 'إعادة التوجيه للاستكمال'
          : 'طلب تعديل على نتيجة التنفيذ';

    const [updated] = await prisma.$transaction([
      prisma.transactionFollowUpDirective.update({
        where: { id: directive.id },
        data: {
          status: nextStatus,
          completedAt: approved ? now : null,
          reviewDecision: input.decision,
          reviewNote: input.reviewNote || null,
          reviewedAt: now,
          reviewedById: reviewer.id,
          reviewedByName: reviewer.name,
          lastUpdatedById: reviewer.id,
          lastUpdatedByName: reviewer.name,
        },
      }),
      prisma.transactionFollowUpDirectiveReview.create({
        data: {
          directiveId: directive.id,
          decision: input.decision,
          previousStatus: directive.status,
          nextStatus,
          reviewNote: input.reviewNote || null,
          completionResponse: directive.completionResponse || null,
          completionNote: directive.completionNote || null,
          submittedAt: directive.completionSubmittedAt || null,
          evidenceSnapshot: evidence,
          reviewedById: reviewer.id,
          reviewedByName: reviewer.name,
          reviewedAt: now,
        },
      }),
      prisma.transactionFollowUpEvent.create({
        data: {
          transactionId: directive.transactionId,
          eventType: 'directive_reviewed',
          fromAssigneeUserId: directive.assigneeUserId,
          fromAssigneeName: directive.assigneeName,
          toAssigneeUserId: directive.assigneeUserId,
          toAssigneeName: directive.assigneeName,
          actionText: `${decisionLabel}: ${directive.title}`,
          note: input.reviewNote || null,
          createdById: reviewer.id,
          createdByName: reviewer.name,
        },
      }),
    ]);

    await createFollowUpAlert({
      alertKey: `directive:${directive.id}:review:${input.decision}:${now.toISOString()}:${directive.assigneeUserId}`,
      transactionId: directive.transactionId,
      userId: directive.assigneeUserId,
      kind: approved ? 'directive_approved' : 'directive_returned',
      severity: approved ? 'info' : 'warning',
      title: approved ? 'تم اعتماد إنجاز التوجيه' : 'أعيد التوجيه للاستكمال',
      message: approved
        ? `${directive.title} — تم اعتماد نتيجة التنفيذ من الإدارة.`
        : `${directive.title} — ${input.decision === 'request_modification' ? 'طلبت الإدارة تعديل نتيجة التنفيذ.' : 'أعيد للاستكمال.'} ${input.reviewNote || ''}`,
    });

    res.json(serializeDirective(updated));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/directives/:directiveId/evidence', async (req, res, next) => {
  try {
    const input = directiveEvidenceSchema.parse(req.body);
    const directive = await prisma.transactionFollowUpDirective.findFirst({
      where: { id: req.params.directiveId, transactionId: req.params.id },
      include: { transaction: { select: { id: true, transactionNumber: true } } },
    });
    if (!directive) return res.status(404).json({ message: 'التوجيه أو القرار غير موجود' });

    const supervisor = isSupervisor(req);
    if (!supervisor && directive.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'هذا التوجيه غير مسند إلى حسابك' });
    }
    if (['awaiting_approval', 'completed', 'cancelled'].includes(directive.status)) {
      return res.status(409).json({ message: 'أدلة التنفيذ تصبح ثابتة أثناء الاعتماد وبعد إغلاق التوجيه' });
    }

    const changedBy = actor(req);
    const attachment = await prisma.attachment.create({
      data: {
        entityType: 'transaction_follow_up_directive',
        entityId: directive.id,
        attachmentType: 'other',
        title: input.title,
        driveUrl: input.driveUrl,
        driveFileId: input.driveFileId || null,
        mimeType: input.mimeType || null,
        notes: input.notes || null,
        createdBy: changedBy.name,
      },
    });

    await prisma.transactionFollowUpEvent.create({
      data: {
        transactionId: directive.transactionId,
        eventType: 'directive_evidence_added',
        fromAssigneeUserId: directive.assigneeUserId,
        fromAssigneeName: directive.assigneeName,
        toAssigneeUserId: directive.assigneeUserId,
        toAssigneeName: directive.assigneeName,
        actionText: `إضافة دليل تنفيذ للتوجيه: ${directive.title}`,
        note: attachment.title,
        createdById: changedBy.id,
        createdByName: changedBy.name,
      },
    });

    res.status(201).json(attachment);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/directives/:directiveId/evidence/:attachmentId', async (req, res, next) => {
  try {
    const directive = await prisma.transactionFollowUpDirective.findFirst({
      where: { id: req.params.directiveId, transactionId: req.params.id },
    });
    if (!directive) return res.status(404).json({ message: 'التوجيه أو القرار غير موجود' });

    const supervisor = isSupervisor(req);
    if (!supervisor && directive.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'هذا التوجيه غير مسند إلى حسابك' });
    }
    if (!supervisor && ['awaiting_approval', 'completed', 'cancelled'].includes(directive.status)) {
      return res.status(409).json({ message: 'لا يمكن حذف أدلة التنفيذ أثناء الاعتماد أو بعد إغلاق التوجيه' });
    }

    const attachment = await prisma.attachment.findFirst({
      where: {
        id: req.params.attachmentId,
        entityType: 'transaction_follow_up_directive',
        entityId: directive.id,
      },
    });
    if (!attachment) return res.status(404).json({ message: 'مرفق دليل التنفيذ غير موجود' });

    if (attachment.driveFileId) {
      try {
        await deleteGoogleDriveFile(attachment.driveFileId);
      } catch (error) {
        console.warn('Unable to delete directive evidence from Google Drive:', error?.message || error);
      }
    }

    await prisma.attachment.delete({ where: { id: attachment.id } });
    const changedBy = actor(req);
    await prisma.transactionFollowUpEvent.create({
      data: {
        transactionId: directive.transactionId,
        eventType: 'directive_evidence_removed',
        fromAssigneeUserId: directive.assigneeUserId,
        fromAssigneeName: directive.assigneeName,
        toAssigneeUserId: directive.assigneeUserId,
        toAssigneeName: directive.assigneeName,
        actionText: `حذف دليل تنفيذ من التوجيه: ${directive.title}`,
        note: attachment.title,
        createdById: changedBy.id,
        createdByName: changedBy.name,
      },
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
      include: {
        events: { orderBy: { createdAt: 'desc' } },
        directives: {
          include: { reviews: { orderBy: { reviewedAt: 'desc' } } },
          orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        },
      },
    });
    if (!row) return res.status(404).json({ message: 'المعاملة غير موجودة' });

    const directiveIds = (row.directives || []).map((item) => item.id);
    const evidence = directiveIds.length
      ? await prisma.attachment.findMany({
          where: {
            entityType: 'transaction_follow_up_directive',
            entityId: { in: directiveIds },
          },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    const evidenceByDirective = new Map();
    evidence.forEach((item) => {
      const items = evidenceByDirective.get(item.entityId) || [];
      items.push(item);
      evidenceByDirective.set(item.entityId, items);
    });

    res.json({
      ...serialize(row),
      directives: (row.directives || []).map((directive) => ({
        ...serializeDirective(directive),
        evidence: evidenceByDirective.get(directive.id) || [],
      })),
    });
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

    if (FINAL_STATUSES.includes(nextStatus)) {
      const openDirectives = await prisma.transactionFollowUpDirective.count({
        where: {
          transactionId: current.id,
          status: { in: ['pending', 'in_progress', 'awaiting_approval', 'returned'] },
        },
      });
      if (openDirectives > 0) {
        return res.status(409).json({
          message: `لا يمكن إنهاء المعاملة قبل معالجة ${openDirectives} من التوجيهات أو القرارات المفتوحة`,
        });
      }
    }

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
