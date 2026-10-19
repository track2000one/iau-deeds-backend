import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { deleteGoogleDriveFile, downloadGoogleDriveFile } from '../services/googleDrive.js';
import {
  archiveTransactionExecutiveReport,
  calculateNextTransactionReportRun,
  syncScheduledTransactionReports,
} from '../services/transactionReports.service.js';
import {
  getOrCreateTransactionBackupSchedule,
  runTransactionFollowUpBackup,
  testTransactionBackupRestore,
  updateTransactionBackupSchedule,
  verifyTransactionBackupRun,
} from '../services/transactionBackup.service.js';

const router = Router();

const OPEN_STATUSES = ['new', 'assigned', 'in_progress', 'waiting_response', 'needs_follow_up'];
const FINAL_STATUSES = ['completed', 'closed'];
const ALL_STATUSES = [...OPEN_STATUSES, ...FINAL_STATUSES];

const transactionTypeSchema = z.enum([
  'incoming_internal',
  'incoming_external',
  'outgoing_internal',
  'outgoing_external',
  'other',
  // Legacy values accepted for records created before the expanded classification.
  'incoming',
  'outgoing',
  'internal',
]);

const organizationalUnitSchema = z.enum([
  'endowments_properties',
  'mosques_prayer_rooms',
]);
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
  transactionDateType: z.enum(['gregorian', 'hijri']).default('gregorian'),
  transactionType: transactionTypeSchema.default('incoming_external'),
  organizationalUnit: organizationalUnitSchema,
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

const archiveActionSchema = z.object({
  note: nullableText(3000),
});

const workQueueQuickActionSchema = z.object({
  action: z.enum([
    'start',
    'waiting_external',
    'resume',
    'needs_follow_up',
    'submit_completion',
    'approve_close',
    'return_to_employee',
    'reopen',
  ]),
  note: nullableText(3000),
});

const extensionRequestCreateSchema = z.object({
  requestedDueDate: z.string().trim().min(1, 'تاريخ التمديد المقترح مطلوب'),
  reason: z.string().trim().min(5, 'سبب طلب التمديد مطلوب').max(3000),
});

const extensionRequestDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewNote: nullableText(3000),
});

const externalWaitCreateSchema = z.object({
  externalEntity: z.string().trim().min(2, 'الجهة المنتظر منها الرد مطلوبة').max(300),
  outboundReferenceNumber: nullableText(200),
  sentAt: z.string().trim().min(1, 'تاريخ إرسال الطلب مطلوب'),
  nextFollowUpDate: z.string().trim().min(1, 'تاريخ المتابعة القادمة مطلوب'),
  notes: nullableText(3000),
});

const externalWaitFollowUpSchema = z.object({
  nextFollowUpDate: z.string().trim().min(1, 'تاريخ المتابعة القادمة مطلوب'),
  note: z.string().trim().min(2, 'نتيجة المتابعة مطلوبة').max(3000),
});

const externalWaitResponseSchema = z.object({
  responseReceivedAt: z.string().trim().min(1, 'تاريخ ورود الرد مطلوب'),
  responseReferenceNumber: nullableText(200),
  responseNote: z.string().trim().min(2, 'ملخص الرد مطلوب').max(3000),
});

const externalWaitCancelSchema = z.object({
  note: z.string().trim().min(2, 'سبب إلغاء الانتظار مطلوب').max(3000),
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

const transactionAttachmentSchema = z.object({
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

const riskAcceptanceRequestSchema = z.object({
  justification: z.string().trim().min(10, 'مبررات قبول الخطر مطلوبة').max(5000),
  compensatingControls: z.array(z.string().trim().min(1).max(1500)).max(20).optional().default([]),
  requestedUntil: z.string().trim().min(1, 'تاريخ انتهاء قبول الخطر مطلوب'),
});

const riskAcceptanceDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewComment: z.string().trim().min(3, 'ملاحظة قرار الاعتماد مطلوبة').max(5000),
});

const riskPolicyKriThresholdSchema = z.object({
  direction: z.enum(['max', 'min']),
  target: z.coerce.number().min(0).max(100000),
  warning: z.coerce.number().min(0).max(100000),
  danger: z.coerce.number().min(0).max(100000),
}).superRefine((value, ctx) => {
  if (value.direction === 'max' && value.danger < value.warning) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'حد الخطر الأحمر يجب أن يساوي أو يتجاوز حد التنبيه الأصفر' });
  }
  if (value.direction === 'min' && value.danger > value.warning) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'في المؤشرات التصاعدية يجب أن يكون حد الخطر الأحمر أقل من أو يساوي حد التنبيه الأصفر' });
  }
});

const riskPolicyCategorySchema = z.object({
  operational: z.coerce.number().int().min(1).max(25),
  process: z.coerce.number().int().min(1).max(25),
  workload: z.coerce.number().int().min(1).max(25),
  compliance: z.coerce.number().int().min(1).max(25),
  technology: z.coerce.number().int().min(1).max(25),
  data: z.coerce.number().int().min(1).max(25),
  financial: z.coerce.number().int().min(1).max(25),
  reputational: z.coerce.number().int().min(1).max(25),
  other: z.coerce.number().int().min(1).max(25),
});

const riskPolicyKriSchema = z.object({
  outsideAppetiteRate: riskPolicyKriThresholdSchema,
  criticalRisks: riskPolicyKriThresholdSchema,
  overdueReviewRate: riskPolicyKriThresholdSchema,
  recurringRiskRate: riskPolicyKriThresholdSchema,
  riskReduction: riskPolicyKriThresholdSchema,
  preventiveFailureRate: riskPolicyKriThresholdSchema,
  predictedBreaches: riskPolicyKriThresholdSchema,
  capaOverdue: riskPolicyKriThresholdSchema,
  pendingRiskAcceptances: riskPolicyKriThresholdSchema,
  expiringRiskAcceptances: riskPolicyKriThresholdSchema,
});

const riskPolicyProposalSchema = z.object({
  name: z.string().trim().min(3, 'اسم سياسة المخاطر مطلوب').max(200),
  statement: z.string().trim().min(10, 'بيان شهية المخاطر مطلوب').max(3000),
  appetiteMaxScore: z.coerce.number().int().min(1).max(25),
  categoryAppetite: riskPolicyCategorySchema,
  kriThresholds: riskPolicyKriSchema,
  effectiveFrom: z.string().trim().min(1, 'تاريخ سريان السياسة مطلوب'),
  changeReason: z.string().trim().min(5, 'مبرر التعديل مطلوب').max(3000),
});

const riskPolicyDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewComment: z.string().trim().min(3, 'ملاحظة قرار الاعتماد مطلوبة').max(3000),
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
  archiveName: nullableText(250),
  notes: nullableText(5000),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  reportType: z.enum(['weekly', 'monthly', 'custom']).default('custom'),
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  assigneeUserId: nullableText(100),
  templateSnapshot: z.unknown().optional().nullable(),
});

const reportArchiveMetadataSchema = z.object({
  archiveName: nullableText(250),
  notes: nullableText(5000),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
});

const reportArchiveGovernanceSchema = z.object({
  governanceStatus: z.enum(['draft', 'final']).optional(),
  isPinned: z.boolean().optional(),
  isDeletionProtected: z.boolean().optional(),
  retentionPolicy: z.enum(['none', 'one_year', 'three_years', 'five_years', 'permanent', 'custom']).optional(),
  retainUntil: nullableText(100),
});

const reportArchiveExportEventSchema = z.object({
  format: z.enum(['pdf', 'excel', 'print']),
  fileName: nullableText(250),
});

const reportScheduleSchema = z.object({
  name: z.string().trim().min(2).max(200),
  frequency: z.enum(['weekly', 'monthly']),
  dayOfWeek: z.coerce.number().int().min(0).max(6).optional().nullable(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).optional().nullable(),
  runHour: z.coerce.number().int().min(0).max(23).default(8),
  assigneeUserId: nullableText(100),
  templateId: nullableText(100),
  isActive: z.boolean().optional().default(true),
});

const flexibleReportCategorySchema = z.enum([
  'completed',
  'overdue',
  'waiting_response',
  'needs_follow_up',
]);

const flexibleReportColumnSchema = z.enum([
  'transactionNumber',
  'transactionDate',
  'subject',
  'transactionType',
  'organizationalUnit',
  'currentAssigneeName',
  'category',
  'priority',
  'dueDate',
  'requiredAction',
]);

const flexibleReportSortSchema = z.enum([
  'transactionDate',
  'transactionNumber',
  'priority',
  'currentAssigneeName',
  'dueDate',
  'category',
]);

const reportTemplateOptionsSchema = z.object({
  title: z.string().trim().max(250).default('التقرير المرن لمتابعة المعاملات'),
  categories: z.array(flexibleReportCategorySchema).min(1).max(4),
  search: z.string().trim().max(500).default(''),
  priority: z.union([prioritySchema, z.literal('')]).default(''),
  organizationalUnit: z.union([organizationalUnitSchema, z.literal('')]).default(''),
  sortBy: flexibleReportSortSchema.default('transactionDate'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  visibleColumns: z.array(flexibleReportColumnSchema).min(1).max(10),
});

const archivedFlexibleReportOptionsSchema = reportTemplateOptionsSchema.extend({
  excludedIds: z.array(z.string().trim().min(1).max(100)).max(5000).default([]),
});

const manualReportArchiveSnapshotSchema = z.object({
  id: z.string().trim().min(1).max(150),
  name: z.string().trim().min(1).max(250),
  scope: z.literal('personal').default('personal'),
  reportMode: z.enum(['weekly', 'monthly', 'custom']),
  customFrom: nullableText(100),
  customTo: nullableText(100),
  assigneeUserId: nullableText(100),
  orientation: z.enum(['portrait', 'landscape']).default('landscape'),
  options: archivedFlexibleReportOptionsSchema,
  accessMode: z.literal('all').default('all'),
  allowedUserIds: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
  isDefault: z.literal(false).default(false),
  sortOrder: z.coerce.number().int().min(0).default(0),
  createdById: nullableText(100),
  createdByName: nullableText(200),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

const reportTemplateSchema = z.object({
  name: z.string().trim().min(2, 'اسم قالب التقرير مطلوب').max(200),
  scope: z.enum(['personal', 'shared']).default('personal'),
  reportMode: z.enum(['weekly', 'monthly', 'custom']).default('monthly'),
  customFrom: nullableText(100),
  customTo: nullableText(100),
  assigneeUserId: nullableText(100),
  orientation: z.enum(['portrait', 'landscape']).default('landscape'),
  options: reportTemplateOptionsSchema,
  accessMode: z.enum(['all', 'selected']).default('all'),
  allowedUserIds: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
  isDefault: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
});

const reportTemplateReorderSchema = z.object({
  scope: z.enum(['personal', 'shared']),
  orderedIds: z.array(z.string().trim().min(1)).min(1).max(200),
});

const reportTemplateCloneSchema = z.object({
  templateId: z.string().trim().min(1),
  name: z.string().trim().min(2).max(200).optional(),
});

const backupScheduleSchema = z.object({
  frequency: z.enum(['weekly', 'monthly']),
  dayOfWeek: z.coerce.number().int().min(0).max(6).optional().nullable(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).optional().nullable(),
  runHour: z.coerce.number().int().min(0).max(23).default(2),
  includeAttachments: z.boolean().default(true),
  retentionCount: z.coerce.number().int().min(1).max(100).default(12),
  isActive: z.boolean().default(false),
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

const normalizeArabicDigits = (value = '') =>
  String(value)
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));

const normalizeTransactionNumber = (value) =>
  normalizeArabicDigits(value).trim();

const invalidTransactionDate = (message = 'تاريخ المعاملة غير صحيح') => {
  const error = new Error(message);
  error.status = 400;
  throw error;
};

const parseGregorianTransactionDate = (value) => {
  const normalized = normalizeArabicDigits(value).trim();
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) invalidTransactionDate('أدخل التاريخ الميلادي بصيغة صحيحة');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    invalidTransactionDate('التاريخ الميلادي المدخل غير صحيح');
  }

  const input = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { transactionDate: date, transactionDateType: 'gregorian', transactionDateInput: input, transactionYear: year };
};

const parseHijriTransactionDate = (value) => {
  const normalized = normalizeArabicDigits(value).trim().replaceAll('-', '/');
  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) invalidTransactionDate('أدخل التاريخ الهجري بصيغة صحيحة مثل 1448/05/10');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 30) {
    invalidTransactionDate('التاريخ الهجري المدخل غير صحيح');
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura-nu-latn', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
  } catch {
    invalidTransactionDate('تعذر تهيئة تقويم أم القرى للتحقق من التاريخ الهجري');
  }

  const estimatedGregorianYear = Math.floor((year * 0.970224) + 621.5774);
  const start = Date.UTC(estimatedGregorianYear - 1, 0, 1);
  const end = Date.UTC(estimatedGregorianYear + 1, 11, 31);
  let transactionDate = null;

  for (let cursor = start; cursor <= end; cursor += 86400000) {
    const parts = formatter.formatToParts(new Date(cursor));
    const values = {};
    parts.forEach((part) => {
      if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
        values[part.type] = Number(part.value);
      }
    });
    if (values.year === year && values.month === month && values.day === day) {
      transactionDate = new Date(cursor);
      break;
    }
  }

  if (!transactionDate) {
    invalidTransactionDate('التاريخ الهجري المدخل غير موجود في تقويم أم القرى');
  }

  const input = `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
  return { transactionDate, transactionDateType: 'hijri', transactionDateInput: input, transactionYear: year };
};

const parseTransactionDate = (value, type = 'gregorian') =>
  type === 'hijri'
    ? parseHijriTransactionDate(value)
    : parseGregorianTransactionDate(value);

const effectiveTransactionYear = (record) => {
  if (Number.isInteger(record?.transactionYear)) return record.transactionYear;
  if (record?.transactionDateType === 'hijri' && record?.transactionDateInput) {
    const match = normalizeArabicDigits(record.transactionDateInput).match(/^(\d{4})[\/-]/);
    if (match) return Number(match[1]);
  }
  const date = record?.transactionDate ? new Date(record.transactionDate) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getUTCFullYear() : null;
};

const duplicateTransactionError = (transactionNumber, transactionYear) => {
  const error = new Error(
    `يوجد معاملة مسجلة مسبقًا برقم (${transactionNumber}) في عام (${transactionYear}). يمكن تكرار الرقم فقط إذا اختلف العام.`,
  );
  error.status = 409;
  return error;
};

const assertUniqueTransactionNumberYear = async ({
  transactionNumber,
  transactionYear,
  excludeId = null,
}) => {
  const rows = await prisma.transactionFollowUp.findMany({
    where: {
      transactionNumber,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: {
      id: true,
      transactionNumber: true,
      transactionDate: true,
      transactionDateType: true,
      transactionDateInput: true,
      transactionYear: true,
    },
  });

  if (rows.some((row) => effectiveTransactionYear(row) === transactionYear)) {
    throw duplicateTransactionError(transactionNumber, transactionYear);
  }
};

const isTransactionNumberYearConstraint = (error) => {
  if (error?.code !== 'P2002') return false;
  const target = Array.isArray(error?.meta?.target)
    ? error.meta.target.join(',')
    : String(error?.meta?.target || '');
  return (
    target.includes('transactionNumber') ||
    target.includes('transactionYear') ||
    target.includes('transaction_follow_up_number_year_key')
  );
};

const actor = (req) => ({
  id: req.authUser?.id || null,
  name: req.authUser?.username || req.authUser?.email || 'مستخدم',
});

const reportArchiveLabel = (archive) =>
  archive?.archiveName
  || archive?.templateName
  || (
    archive?.reportType === 'weekly'
      ? 'تقرير أسبوعي'
      : archive?.reportType === 'monthly'
        ? 'تقرير شهري'
        : 'تقرير مخصص'
  );

const auditReportArchiveAction = async (
  req,
  {
    action,
    archive,
    description,
    details = null,
    previousData = null,
    newData = null,
  },
) => {
  try {
    await prisma.auditLog.create({
      data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action,
        module: 'transaction_follow_up',
        entity: 'report_archive',
        entityId: archive?.id || null,
        entityLabel: reportArchiveLabel(archive),
        description,
        details,
        previousData,
        newData,
        ipAddress: req.ip || null,
        userAgent: req.get?.('user-agent') || null,
      },
    });
  } catch (error) {
    console.warn('Unable to write report archive audit log', error?.message || error);
  }
};

const retentionExpiryForArchive = (archive) => {
  const createdAt = archive?.createdAt ? new Date(archive.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return null;

  const expiry = new Date(createdAt);
  if (archive.retentionPolicy === 'one_year') expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
  else if (archive.retentionPolicy === 'three_years') expiry.setUTCFullYear(expiry.getUTCFullYear() + 3);
  else if (archive.retentionPolicy === 'five_years') expiry.setUTCFullYear(expiry.getUTCFullYear() + 5);
  else if (archive.retentionPolicy === 'custom' && archive.retainUntil) {
    const custom = new Date(archive.retainUntil);
    return Number.isNaN(custom.getTime()) ? null : custom;
  } else {
    return null;
  }
  return expiry;
};

const archiveDeletionBlockReason = (archive, now = new Date()) => {
  if (archive?.governanceStatus === 'final') {
    return 'التقرير نهائي؛ أعده إلى مسودة قبل الحذف';
  }
  if (archive?.isDeletionProtected) {
    return 'التقرير محمي من الحذف';
  }
  if (archive?.retentionPolicy === 'permanent') {
    return 'سياسة الاحتفاظ لهذا التقرير دائمة';
  }
  const expiry = retentionExpiryForArchive(archive);
  if (expiry && expiry.getTime() > now.getTime()) {
    return `لا يمكن حذف التقرير قبل انتهاء مدة الاحتفاظ في ${expiry.toISOString().slice(0, 10)}`;
  }
  return null;
};

const modulePermission = (req) =>
  req.authUser?.permissions?.find((item) => item.module === 'transaction_follow_up');

const archiveModulePermission = (req) =>
  req.authUser?.permissions?.find((item) => item.module === 'archive');

const isSupervisor = (req) =>
  req.authUser?.role === 'admin' || Boolean(modulePermission(req)?.canDelete);

const templateAllowedUserIds = (template) =>
  Array.isArray(template?.allowedUserIds)
    ? template.allowedUserIds.map((value) => String(value))
    : [];

const canUseReportTemplate = (req, template) => {
  if (!template) return false;
  if (template.createdById === req.authUser?.id) return true;
  if (template.scope !== 'shared') return false;
  if (isSupervisor(req)) return true;
  if (template.accessMode !== 'selected') return true;
  return templateAllowedUserIds(template).includes(req.authUser?.id);
};

const reportTemplateScheduleSnapshot = (template) => {
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

const resolveScheduleTemplate = async (req, templateId) => {
  if (!templateId) return null;
  const template = await prisma.transactionFollowUpReportTemplate.findUnique({
    where: { id: templateId },
  });
  if (!template) {
    const error = new Error('قالب التقرير المحدد غير موجود');
    error.status = 404;
    throw error;
  }
  if (!canUseReportTemplate(req, template)) {
    const error = new Error('لا يمكنك استخدام قالب التقرير المحدد');
    error.status = 403;
    throw error;
  }
  return template;
};

const normalizeTemplateAllowedUserIds = async (inputIds = []) => {
  const ids = Array.from(new Set(
    (Array.isArray(inputIds) ? inputIds : [])
      .map((value) => String(value).trim())
      .filter(Boolean),
  ));
  if (!ids.length) return [];

  const users = await prisma.appUser.findMany({
    where: {
      id: { in: ids },
      isActive: true,
      OR: [
        { role: 'admin' },
        { permissions: { some: { module: 'transaction_follow_up', canView: true } } },
      ],
    },
    select: { id: true },
  });

  return users.map((user) => user.id);
};

const nextTemplateSortOrder = async (scope, createdById) => {
  const aggregate = await prisma.transactionFollowUpReportTemplate.aggregate({
    where: scope === 'shared'
      ? { scope: 'shared' }
      : { scope: 'personal', createdById },
    _max: { sortOrder: true },
  });
  return Number(aggregate._max.sortOrder || 0) + 10;
};

const canViewTransactionArchive = (req) =>
  req.authUser?.role === 'admin' || Boolean(archiveModulePermission(req)?.canView);

const canArchiveTransaction = (req) =>
  req.authUser?.role === 'admin' || Boolean(archiveModulePermission(req)?.canAdd);

const canRestoreTransactionArchive = (req) =>
  req.authUser?.role === 'admin' || Boolean(archiveModulePermission(req)?.canEdit);

const hasModuleViewPermission = (req, moduleName) =>
  req.authUser?.role === 'admin' ||
  Boolean(
    req.authUser?.permissions?.find((item) => item.module === moduleName)?.canView,
  );

const riskModuleForPath = (path = '') => {
  if (/^\/directives\/risk-policy(?:\/|$)/.test(path)) {
    return 'transaction_risk_policy';
  }
  if (/^\/directives\/risk-dashboard(?:\/|$)/.test(path)) {
    return 'transaction_risk_executive';
  }
  if (
    /^\/directives\/risk-acceptances(?:\/|$)/.test(path) ||
    /^\/directives\/risks\/[^/]+\/acceptance-requests(?:\/|$)/.test(path)
  ) {
    return 'transaction_risk_acceptance';
  }
  if (/^\/directives\/risks(?:\/|$)/.test(path)) {
    return 'transaction_risk_register';
  }
  return null;
};

router.use((req, res, next) => {
  const moduleName = riskModuleForPath(req.path);
  if (!moduleName) return next();
  if (hasModuleViewPermission(req, moduleName)) return next();

  return res.status(403).json({
    message: 'هذه الصفحة متاحة للمسؤول فقط أو للمستخدم الذي منحه المسؤول صلاحية الاطلاع عليها.',
  });
});

const RISK_CATEGORY_KEYS = [
  'operational',
  'process',
  'workload',
  'compliance',
  'technology',
  'data',
  'financial',
  'reputational',
  'other',
];

const DEFAULT_CATEGORY_APPETITE = {
  operational: 9,
  process: 9,
  workload: 9,
  compliance: 9,
  technology: 9,
  data: 9,
  financial: 9,
  reputational: 9,
  other: 9,
};

const DEFAULT_RISK_KRI_THRESHOLDS = {
  outsideAppetiteRate: { direction: 'max', target: 10, warning: 10, danger: 25 },
  criticalRisks: { direction: 'max', target: 0, warning: 1, danger: 3 },
  overdueReviewRate: { direction: 'max', target: 10, warning: 10, danger: 20 },
  recurringRiskRate: { direction: 'max', target: 10, warning: 10, danger: 20 },
  riskReduction: { direction: 'min', target: 30, warning: 30, danger: 15 },
  preventiveFailureRate: { direction: 'max', target: 15, warning: 15, danger: 30 },
  predictedBreaches: { direction: 'max', target: 0, warning: 1, danger: 2 },
  capaOverdue: { direction: 'max', target: 0, warning: 1, danger: 3 },
  pendingRiskAcceptances: { direction: 'max', target: 0, warning: 1, danger: 4 },
  expiringRiskAcceptances: { direction: 'max', target: 0, warning: 1, danger: 3 },
};

const DEFAULT_RISK_POLICY = {
  id: null,
  versionNumber: 0,
  name: 'السياسة الافتراضية لشهية المخاطر',
  statement: 'الحد العام المقبول للخطر المتبقي هو 9 من 25؛ وما فوق الحد المعتمد للفئة يتطلب معالجة أو قبولًا إشرافيًا موثقًا.',
  appetiteMaxScore: 9,
  categoryAppetite: DEFAULT_CATEGORY_APPETITE,
  kriThresholds: DEFAULT_RISK_KRI_THRESHOLDS,
  effectiveFrom: null,
  effectiveTo: null,
  status: 'default',
  changeReason: 'الإعداد الافتراضي للنظام قبل اعتماد أول إصدار رسمي.',
  proposedById: null,
  proposedByName: 'النظام',
  reviewedById: null,
  reviewedByName: null,
  reviewComment: null,
  submittedAt: null,
  decisionAt: null,
  createdAt: null,
  updatedAt: null,
};

const normalizeRiskPolicy = (policy) => {
  if (!policy) return {
    ...DEFAULT_RISK_POLICY,
    categoryAppetite: { ...DEFAULT_CATEGORY_APPETITE },
    kriThresholds: Object.fromEntries(
      Object.entries(DEFAULT_RISK_KRI_THRESHOLDS).map(([key, value]) => [key, { ...value }])
    ),
  };

  const storedCategories =
    policy.categoryAppetite && typeof policy.categoryAppetite === 'object' && !Array.isArray(policy.categoryAppetite)
      ? policy.categoryAppetite
      : {};
  const storedKri =
    policy.kriThresholds && typeof policy.kriThresholds === 'object' && !Array.isArray(policy.kriThresholds)
      ? policy.kriThresholds
      : {};

  return {
    ...policy,
    categoryAppetite: {
      ...DEFAULT_CATEGORY_APPETITE,
      ...storedCategories,
    },
    kriThresholds: Object.fromEntries(
      Object.entries(DEFAULT_RISK_KRI_THRESHOLDS).map(([key, fallback]) => [
        key,
        {
          ...fallback,
          ...(storedKri[key] && typeof storedKri[key] === 'object' ? storedKri[key] : {}),
        },
      ])
    ),
  };
};

const getEffectiveRiskPolicy = async (referenceDate = new Date()) => {
  const policy = await prisma.transactionFollowUpRiskPolicy.findFirst({
    where: {
      status: 'approved',
      effectiveFrom: { lte: referenceDate },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gt: referenceDate } },
      ],
    },
    orderBy: [
      { effectiveFrom: 'desc' },
      { versionNumber: 'desc' },
    ],
  });
  return normalizeRiskPolicy(policy);
};

const getRiskAppetiteLimit = (policy, category) => {
  const normalized = normalizeRiskPolicy(policy);
  const categoryLimit = Number(normalized.categoryAppetite?.[category]);
  return Number.isFinite(categoryLimit) && categoryLimit >= 1 && categoryLimit <= 25
    ? categoryLimit
    : normalized.appetiteMaxScore;
};

const getRiskKriThreshold = (policy, key) => {
  const normalized = normalizeRiskPolicy(policy);
  return normalized.kriThresholds?.[key] || DEFAULT_RISK_KRI_THRESHOLDS[key];
};

const evaluateRiskKriStatus = (value, threshold) => {
  if (value == null || Number.isNaN(Number(value))) return 'neutral';
  if (threshold.direction === 'min') {
    if (value <= threshold.danger) return 'red';
    if (value <= threshold.warning) return 'yellow';
    return 'green';
  }
  if (value >= threshold.danger) return 'red';
  if (value >= threshold.warning) return 'yellow';
  return 'green';
};

const riskKriTargetLabel = (threshold, unit = '') => {
  const operator = threshold.direction === 'min' ? '≥' : '≤';
  return `${operator} ${threshold.target}${unit === '%' ? '%' : ''}`;
};

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

const serializeRisk = (risk, policy = DEFAULT_RISK_POLICY) => {
  const now = new Date();
  const active = !['closed'].includes(risk.status);
  const reviewOverdue = Boolean(
    active &&
    risk.reviewDate &&
    new Date(risk.reviewDate).getTime() < now.getTime()
  );
  const latestAcceptance = Array.isArray(risk.acceptanceRequests)
    ? risk.acceptanceRequests[0] || null
    : null;
  const acceptanceExpiresSoon = Boolean(
    risk.status === 'accepted' &&
    risk.acceptanceExpiresAt &&
    new Date(risk.acceptanceExpiresAt).getTime() > now.getTime() &&
    new Date(risk.acceptanceExpiresAt).getTime() <= now.getTime() + 7 * 86400000
  );
  const appetiteLimit = getRiskAppetiteLimit(policy, risk.category);
  return {
    ...risk,
    latestAcceptance,
    appetiteLimit,
    outsideAppetite: Number(risk.residualScore) > appetiteLimit,
    isReviewOverdue: reviewOverdue,
    acceptanceExpiresSoon,
  };
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

const hasFollowUpPermission = (req, action) =>
  req.authUser?.role === 'admin' || Boolean(modulePermission(req)?.[action]);

const canViewRecord = (req, record) =>
  hasFollowUpPermission(req, 'canView') &&
  (
    isSupervisor(req) ||
    record.currentAssigneeUserId === req.authUser?.id ||
    record.createdById === req.authUser?.id
  );

const canActOnRecord = (req, record) =>
  hasFollowUpPermission(req, 'canEdit') &&
  (
    isSupervisor(req) ||
    record.currentAssigneeUserId === req.authUser?.id
  );

const canEditRecordMaster = (req, record) =>
  hasFollowUpPermission(req, 'canEdit') &&
  (
    isSupervisor(req) ||
    record.currentAssigneeUserId === req.authUser?.id
  );

const canDeleteRecord = (req) =>
  hasFollowUpPermission(req, 'canDelete');

const canReopenRecord = (req) =>
  hasFollowUpPermission(req, 'canReopen');

const canTransferRecord = (req) =>
  isSupervisor(req) || hasFollowUpPermission(req, 'canTransfer');

const denyRecordAccess = (res, action = 'edit') => {
  const message =
    action === 'delete'
      ? 'لا تملك صلاحية حذف المعاملات في نظام المتابعة'
      : 'لا تملك صلاحية تعديل هذه المعاملة، أو أنها ليست ضمن نطاق عملك';
  return res.status(403).json({ message });
};

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
      indicatorLabel: 'تحتاج تعيين موظف',
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

const classifyWorkQueueItem = (record, todayNumber) => {
  if (record.status === 'completed') return 'awaiting_review';
  if (record.status === 'closed') return 'completed_today';
  if (!record.currentAssigneeUserId) return 'unassigned';

  const dueKey = record.dueDate ? saudiDayKey(new Date(record.dueDate)) : null;
  const dueNumber = dueKey ? dayNumberFromKey(dueKey) : null;
  const daysUntilDue = dueNumber == null ? null : dueNumber - todayNumber;

  if (daysUntilDue != null && daysUntilDue < 0) return 'overdue';
  if (record.priority === 'urgent' || daysUntilDue === 0) return 'urgent_today';
  if (daysUntilDue != null && daysUntilDue >= 1 && daysUntilDue <= 3) return 'due_3_days';
  if (record.status === 'waiting_response') return 'waiting_external';
  return 'in_progress';
};

const workQueueActionOptions = (record, supervisor, canReopen) => {
  if (record.status === 'closed') return canReopen ? ['reopen'] : [];
  if (record.status === 'completed') {
    const actions = supervisor ? ['approve_close', 'return_to_employee'] : [];
    if (canReopen) actions.push('reopen');
    return actions;
  }
  const actions = [];
  if (record.status === 'waiting_response') actions.push('resume');
  if (['assigned', 'in_progress', 'needs_follow_up'].includes(record.status)) {
    actions.push('waiting_external');
  }
  if (['assigned', 'in_progress', 'waiting_response'].includes(record.status)) {
    actions.push('needs_follow_up');
  }
  if (record.currentAssigneeUserId) actions.push('submit_completion');
  return actions;
};

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
  const [rows, directives, improvementPlans, preventiveActions, risks, riskAcceptances, externalWaits] = await Promise.all([
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
    prisma.transactionFollowUpRiskAcceptanceRequest.findMany({
      where: { status: { in: ['pending', 'approved'] } },
      include: {
        risk: {
          select: {
            id: true,
            riskNumber: true,
            title: true,
            status: true,
            ownerUserId: true,
            residualProbability: true,
            residualImpact: true,
            residualScore: true,
            residualLevel: true,
          },
        },
      },
    }),
    prisma.transactionFollowUpExternalWait.findMany({
      where: { status: 'active' },
      include: {
        transaction: {
          select: {
            id: true,
            transactionNumber: true,
            subject: true,
            currentAssigneeUserId: true,
            currentAssigneeName: true,
            status: true,
          },
        },
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

  for (const wait of externalWaits) {
    const transaction = wait.transaction;
    if (!transaction) continue;

    const followUpNumber = dayNumberFromKey(saudiDayKey(new Date(wait.nextFollowUpDate)));
    const daysOverdue = todayNumber - followUpNumber;
    if (daysOverdue < 0) continue;

    const waitingDays = Math.max(
      0,
      todayNumber - dayNumberFromKey(saudiDayKey(new Date(wait.sentAt)))
    );
    const recipients = new Set([
      transaction.currentAssigneeUserId,
      ...(daysOverdue >= 2 ? supervisorIds : []),
    ].filter(Boolean));

    for (const userId of recipients) {
      const overdue = daysOverdue > 0;
      await createFollowUpAlert({
        alertKey: `transaction:${transaction.id}:external_follow_up:${wait.id}:${todayKey}:${userId}`,
        transactionId: transaction.id,
        userId,
        kind: overdue ? 'external_follow_up_overdue' : 'external_follow_up_due_today',
        severity: overdue ? 'danger' : 'warning',
        title: overdue ? 'متابعة جهة خارجية متأخرة' : 'موعد متابعة جهة خارجية اليوم',
        message: overdue
          ? `${transaction.transactionNumber} — بانتظار رد من ${wait.externalEntity} منذ ${waitingDays} يوم، والمتابعة متأخرة ${daysOverdue} يوم.`
          : `${transaction.transactionNumber} — حان موعد متابعة ${wait.externalEntity}. مدة الانتظار الحالية ${waitingDays} يوم.`,
      });
      alerts += 1;
    }
  }

  for (const acceptance of riskAcceptances) {
    const risk = acceptance.risk;
    if (!risk) continue;

    if (acceptance.status === 'pending') {
      const requestedUntilKey = saudiDayKey(new Date(acceptance.requestedUntil));
      const requestedUntilNumber = dayNumberFromKey(requestedUntilKey);
      if (requestedUntilNumber < todayNumber) {
        const expiredAt = new Date();
        await prisma.$transaction(async (tx) => {
          const updated = await tx.transactionFollowUpRiskAcceptanceRequest.updateMany({
            where: { id: acceptance.id, status: 'pending' },
            data: { status: 'expired', expiredAt },
          });
          if (updated.count) {
            await tx.transactionFollowUpRiskRegisterEvent.create({
              data: {
                riskId: risk.id,
                action: 'acceptance_request_expired',
                fromStatus: risk.status,
                toStatus: risk.status,
                residualProbability: risk.residualProbability,
                residualImpact: risk.residualImpact,
                residualScore: risk.residualScore,
                residualLevel: risk.residualLevel,
                note: 'انتهت صلاحية طلب قبول الخطر قبل اتخاذ قرار الاعتماد.',
                changedById: null,
                changedByName: 'النظام',
              },
            });
          }
        });
        const recipients = new Set([
          acceptance.requestedById,
          risk.ownerUserId,
          ...supervisorIds,
        ].filter(Boolean));
        for (const userId of recipients) {
          await createFollowUpAlert({
            alertKey: `risk:${risk.id}:acceptance_request_expired:${acceptance.id}:${userId}`,
            transactionId: null,
            userId,
            kind: 'risk_acceptance_request_expired',
            severity: 'warning',
            title: 'انتهت صلاحية طلب قبول خطر',
            message: `${risk.riskNumber} — انتهت المدة المطلوبة قبل اعتماد طلب القبول، ويلزم رفع طلب جديد عند الحاجة.`,
          });
          alerts += 1;
        }
        continue;
      }

      const ageDays = Math.max(
        0,
        todayNumber - dayNumberFromKey(saudiDayKey(new Date(acceptance.createdAt)))
      );
      if (ageDays >= 2) {
        const recipients = new Set([risk.ownerUserId, ...supervisorIds].filter(Boolean));
        for (const userId of recipients) {
          if (userId === acceptance.requestedById) continue;
          await createFollowUpAlert({
            alertKey: `risk:${risk.id}:acceptance_pending_overdue:${todayKey}:${userId}`,
            transactionId: null,
            userId,
            kind: 'risk_acceptance_pending_overdue',
            severity: ageDays >= 5 ? 'danger' : 'warning',
            title: 'طلب قبول خطر بانتظار الاعتماد',
            message: `${risk.riskNumber} — طلب قبول الخطر معلق منذ ${ageDays} يوم.`,
          });
          alerts += 1;
        }
      }
      continue;
    }

    const untilKey = saudiDayKey(new Date(acceptance.requestedUntil));
    const untilNumber = dayNumberFromKey(untilKey);
    const daysUntilExpiry = untilNumber - todayNumber;

    if (daysUntilExpiry < 0) {
      const expiredAt = new Date();
      await prisma.$transaction(async (tx) => {
        const currentAcceptance = await tx.transactionFollowUpRiskAcceptanceRequest.findUnique({
          where: { id: acceptance.id },
        });
        if (!currentAcceptance || currentAcceptance.status !== 'approved') return;

        await tx.transactionFollowUpRiskAcceptanceRequest.update({
          where: { id: acceptance.id },
          data: { status: 'expired', expiredAt },
        });

        if (risk.status === 'accepted') {
          await tx.transactionFollowUpRiskRegister.update({
            where: { id: risk.id },
            data: {
              status: 'monitoring',
              reviewDate: expiredAt,
              updatedById: null,
              updatedByName: 'النظام',
            },
          });
          await tx.transactionFollowUpRiskRegisterEvent.create({
            data: {
              riskId: risk.id,
              action: 'acceptance_expired',
              fromStatus: 'accepted',
              toStatus: 'monitoring',
              residualProbability: risk.residualProbability,
              residualImpact: risk.residualImpact,
              residualScore: risk.residualScore,
              residualLevel: risk.residualLevel,
              note: 'انتهت مدة قبول الخطر تلقائيًا وأعيد إلى المراقبة لإعادة التقييم.',
              changedById: null,
              changedByName: 'النظام',
            },
          });
        }
      });

      const recipients = new Set([
        acceptance.requestedById,
        risk.ownerUserId,
        ...supervisorIds,
      ].filter(Boolean));
      for (const userId of recipients) {
        await createFollowUpAlert({
          alertKey: `risk:${risk.id}:acceptance_expired:${acceptance.id}:${userId}`,
          transactionId: null,
          userId,
          kind: 'risk_acceptance_expired',
          severity: risk.residualScore > 9 ? 'danger' : 'warning',
          title: 'انتهت مدة قبول خطر',
          message: `${risk.riskNumber} — انتهت مدة قبول الخطر وأعيد إلى المراقبة لإعادة التقييم.`,
        });
        alerts += 1;
      }
      continue;
    }

    if ([7, 3, 1, 0].includes(daysUntilExpiry)) {
      const recipients = new Set([
        acceptance.requestedById,
        risk.ownerUserId,
        ...supervisorIds,
      ].filter(Boolean));
      for (const userId of recipients) {
        await createFollowUpAlert({
          alertKey: `risk:${risk.id}:acceptance_expiring:${todayKey}:${userId}`,
          transactionId: null,
          userId,
          kind: 'risk_acceptance_expiring',
          severity: daysUntilExpiry <= 1 ? 'danger' : 'warning',
          title: daysUntilExpiry === 0 ? 'ينتهي قبول خطر اليوم' : 'قبول خطر يقترب من الانتهاء',
          message: daysUntilExpiry === 0
            ? `${risk.riskNumber} — تنتهي مدة قبول الخطر اليوم ويلزم تقرير الاستمرار أو إعادة المعالجة.`
            : `${risk.riskNumber} — يتبقى ${daysUntilExpiry} يوم على انتهاء مدة قبول الخطر.`,
        });
        alerts += 1;
      }
    }
  }

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

  return {
    scanned:
      rows.length +
      directives.length +
      improvementPlans.length +
      preventiveActions.length +
      risks.length +
      riskAcceptances.length +
      externalWaits.length,
    alerts,
  };
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
    const organizationalUnit = String(req.query.organizationalUnit || '').trim();
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
          orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
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

router.get('/directives/risk-policy', async (req, res, next) => {
  try {
    const now = new Date();
    const supervisor = isSupervisor(req);
    const current = await getEffectiveRiskPolicy(now);
    const [pending, history] = await Promise.all([
      supervisor
        ? prisma.transactionFollowUpRiskPolicy.findMany({
            where: { status: 'pending' },
            orderBy: [{ versionNumber: 'desc' }],
            take: 10,
          })
        : Promise.resolve([]),
      prisma.transactionFollowUpRiskPolicy.findMany({
        where: { status: { in: ['approved', 'rejected', 'cancelled'] } },
        orderBy: [{ versionNumber: 'desc' }],
        take: 25,
      }),
    ]);

    res.json({
      generatedAt: now,
      supervisor,
      current,
      pending: pending.map(normalizeRiskPolicy),
      history: history.map(normalizeRiskPolicy),
      defaults: normalizeRiskPolicy(null),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/directives/risk-policy/proposals', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'اقتراح تعديل سياسة المخاطر متاح للمستخدم الإشرافي فقط' });
    }

    const input = riskPolicyProposalSchema.parse(req.body);
    const effectiveFrom = toDate(input.effectiveFrom, 'تاريخ سريان السياسة');
    const todayNumber = dayNumberFromKey(saudiDayKey());
    const effectiveNumber = dayNumberFromKey(saudiDayKey(effectiveFrom));
    if (effectiveNumber < todayNumber) {
      return res.status(400).json({ message: 'تاريخ سريان السياسة لا يمكن أن يكون في الماضي' });
    }

    const existingPending = await prisma.transactionFollowUpRiskPolicy.findFirst({
      where: { status: 'pending' },
      orderBy: { versionNumber: 'desc' },
    });
    if (existingPending) {
      return res.status(409).json({
        message: `يوجد مقترح سياسة معلق بالفعل (الإصدار ${existingPending.versionNumber})؛ يجب البت فيه أولًا`,
      });
    }

    const sameEffectiveDate = await prisma.transactionFollowUpRiskPolicy.findFirst({
      where: {
        status: 'approved',
        effectiveFrom,
      },
    });
    if (sameEffectiveDate) {
      return res.status(409).json({ message: 'يوجد إصدار معتمد يبدأ في التاريخ نفسه؛ اختر تاريخ سريان مختلفًا' });
    }

    const latest = await prisma.transactionFollowUpRiskPolicy.findFirst({
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    const proposedBy = actor(req);
    const proposal = await prisma.transactionFollowUpRiskPolicy.create({
      data: {
        versionNumber: (latest?.versionNumber || 0) + 1,
        name: input.name,
        statement: input.statement,
        appetiteMaxScore: input.appetiteMaxScore,
        categoryAppetite: input.categoryAppetite,
        kriThresholds: input.kriThresholds,
        effectiveFrom,
        status: 'pending',
        changeReason: input.changeReason,
        proposedById: proposedBy.id,
        proposedByName: proposedBy.name,
      },
    });

    const supervisorIds = await getFollowUpSupervisorIds();
    for (const userId of supervisorIds) {
      if (userId === proposedBy.id) continue;
      await createFollowUpAlert({
        alertKey: `risk-policy:${proposal.id}:pending:${userId}`,
        transactionId: null,
        userId,
        kind: 'risk_policy_pending',
        severity: 'warning',
        title: 'مقترح تعديل سياسة المخاطر',
        message: `الإصدار ${proposal.versionNumber} من «${proposal.name}» بانتظار المراجعة والاعتماد.`,
      });
    }

    res.status(201).json(normalizeRiskPolicy(proposal));
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/risk-policy/proposals/:id/decision', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'اعتماد سياسة المخاطر متاح للمستخدم الإشرافي فقط' });
    }

    const input = riskPolicyDecisionSchema.parse(req.body);
    const proposal = await prisma.transactionFollowUpRiskPolicy.findUnique({
      where: { id: req.params.id },
    });
    if (!proposal) return res.status(404).json({ message: 'مقترح سياسة المخاطر غير موجود' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ message: 'تم البت في مقترح سياسة المخاطر مسبقًا' });
    }

    const reviewer = actor(req);
    if (proposal.proposedById === reviewer.id) {
      const supervisorIds = await getFollowUpSupervisorIds();
      const hasOtherApprover = supervisorIds.some((id) => id !== reviewer.id);
      if (hasOtherApprover || req.authUser?.role !== 'admin') {
        return res.status(409).json({
          message: 'لا يمكن لمقدم مقترح السياسة اعتماد مقترحه؛ يلزم اعتماد مشرف آخر',
        });
      }
    }

    const approved = input.decision === 'approved';
    const now = new Date();

    if (approved) {
      const sameEffective = await prisma.transactionFollowUpRiskPolicy.findFirst({
        where: {
          id: { not: proposal.id },
          status: 'approved',
          effectiveFrom: proposal.effectiveFrom,
        },
      });
      if (sameEffective) {
        return res.status(409).json({ message: 'يوجد إصدار معتمد يبدأ في تاريخ السريان نفسه' });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      let effectiveTo = proposal.effectiveTo;
      if (approved) {
        const nextApproved = await tx.transactionFollowUpRiskPolicy.findFirst({
          where: {
            id: { not: proposal.id },
            status: 'approved',
            effectiveFrom: { gt: proposal.effectiveFrom },
          },
          orderBy: { effectiveFrom: 'asc' },
        });
        effectiveTo = nextApproved?.effectiveFrom || null;

        await tx.transactionFollowUpRiskPolicy.updateMany({
          where: {
            id: { not: proposal.id },
            status: 'approved',
            effectiveFrom: { lt: proposal.effectiveFrom },
            OR: [
              { effectiveTo: null },
              { effectiveTo: { gt: proposal.effectiveFrom } },
            ],
          },
          data: { effectiveTo: proposal.effectiveFrom },
        });
      }

      return tx.transactionFollowUpRiskPolicy.update({
        where: { id: proposal.id },
        data: {
          status: input.decision,
          effectiveTo: approved ? effectiveTo : proposal.effectiveTo,
          reviewedById: reviewer.id,
          reviewedByName: reviewer.name,
          reviewComment: input.reviewComment,
          decisionAt: now,
        },
      });
    });

    const recipients = new Set([
      proposal.proposedById,
      ...(await getFollowUpSupervisorIds()),
    ].filter(Boolean));
    for (const userId of recipients) {
      if (userId === reviewer.id) continue;
      await createFollowUpAlert({
        alertKey: `risk-policy:${proposal.id}:${input.decision}:${userId}`,
        transactionId: null,
        userId,
        kind: approved ? 'risk_policy_approved' : 'risk_policy_rejected',
        severity: approved ? 'info' : 'warning',
        title: approved ? 'تم اعتماد سياسة المخاطر' : 'تم رفض مقترح سياسة المخاطر',
        message: approved
          ? `اعتمد الإصدار ${proposal.versionNumber} ويسري من ${saudiDayKey(new Date(proposal.effectiveFrom))}.`
          : `رُفض الإصدار ${proposal.versionNumber}: ${input.reviewComment}`,
      });
    }

    res.json(normalizeRiskPolicy(updated));
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/risk-policy/proposals/:id/cancel', async (req, res, next) => {
  try {
    const proposal = await prisma.transactionFollowUpRiskPolicy.findUnique({
      where: { id: req.params.id },
    });
    if (!proposal) return res.status(404).json({ message: 'مقترح سياسة المخاطر غير موجود' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ message: 'لا يمكن إلغاء مقترح تم البت فيه' });
    }

    const supervisor = isSupervisor(req);
    if (!supervisor && proposal.proposedById !== req.authUser?.id) {
      return res.status(403).json({ message: 'لا يمكنك إلغاء هذا المقترح' });
    }

    const changedBy = actor(req);
    const updated = await prisma.transactionFollowUpRiskPolicy.update({
      where: { id: proposal.id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        reviewedById: changedBy.id,
        reviewedByName: changedBy.name,
        reviewComment: 'أُلغي المقترح قبل اتخاذ قرار الاعتماد.',
      },
    });

    res.json(normalizeRiskPolicy(updated));
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
      riskPolicy,
    ] = await Promise.all([
      prisma.transactionFollowUpRiskRegister.count({ where: filters }),
      prisma.transactionFollowUpRiskRegister.findMany({
        where: filters,
        include: {
          events: { orderBy: { createdAt: 'desc' }, take: 10 },
          acceptanceRequests: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
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
      getEffectiveRiskPolicy(now),
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
      policy: {
        id: riskPolicy.id,
        versionNumber: riskPolicy.versionNumber,
        name: riskPolicy.name,
        appetiteMaxScore: riskPolicy.appetiteMaxScore,
        categoryAppetite: riskPolicy.categoryAppetite,
        effectiveFrom: riskPolicy.effectiveFrom,
      },
      items: items.map((item) => serializeRisk(item, riskPolicy)),
      total,
      page,
      pageSize,
      totalPages: total ? Math.ceil(total / pageSize) : 0,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/directives/risk-acceptances', async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(10, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));
    const supervisor = isSupervisor(req);
    const currentUserId = req.authUser?.id;
    const visibility = supervisor
      ? {}
      : {
          OR: [
            { requestedById: currentUserId },
            { risk: { ownerUserId: currentUserId } },
            { risk: { assigneeUserId: currentUserId } },
          ],
        };
    const filters = {
      ...visibility,
      ...(['pending', 'approved', 'rejected', 'cancelled', 'expired'].includes(status)
        ? { status }
        : {}),
    };
    const now = new Date();
    const todayStart = new Date(`${saudiDayKey(now)}T00:00:00.000Z`);
    const sevenDays = new Date(todayStart.getTime() + 7 * 86400000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const [total, items, pending, activeApproved, expiringSoon, rejected30d, expired30d] = await Promise.all([
      prisma.transactionFollowUpRiskAcceptanceRequest.count({ where: filters }),
      prisma.transactionFollowUpRiskAcceptanceRequest.findMany({
        where: filters,
        include: {
          risk: {
            select: {
              id: true,
              riskNumber: true,
              title: true,
              category: true,
              ownerUserId: true,
              ownerName: true,
              assigneeUserId: true,
              assigneeName: true,
              residualScore: true,
              residualLevel: true,
              status: true,
              acceptanceExpiresAt: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.transactionFollowUpRiskAcceptanceRequest.count({
        where: { ...visibility, status: 'pending' },
      }),
      prisma.transactionFollowUpRiskAcceptanceRequest.count({
        where: {
          ...visibility,
          status: 'approved',
          requestedUntil: { gte: todayStart },
          risk: { status: 'accepted' },
        },
      }),
      prisma.transactionFollowUpRiskAcceptanceRequest.count({
        where: {
          ...visibility,
          status: 'approved',
          requestedUntil: { gte: todayStart, lte: sevenDays },
          risk: { status: 'accepted' },
        },
      }),
      prisma.transactionFollowUpRiskAcceptanceRequest.count({
        where: {
          ...visibility,
          status: 'rejected',
          decisionAt: { gte: thirtyDaysAgo },
        },
      }),
      prisma.transactionFollowUpRiskAcceptanceRequest.count({
        where: {
          ...visibility,
          status: 'expired',
          expiredAt: { gte: thirtyDaysAgo },
        },
      }),
    ]);

    res.json({
      generatedAt: now,
      supervisor,
      summary: {
        pending,
        activeApproved,
        expiringSoon,
        rejected30d,
        expired30d,
      },
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

router.post('/directives/risks/:id/acceptance-requests', async (req, res, next) => {
  try {
    const input = riskAcceptanceRequestSchema.parse(req.body);
    const risk = await prisma.transactionFollowUpRiskRegister.findUnique({
      where: { id: req.params.id },
      include: {
        acceptanceRequests: {
          where: { status: 'pending' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!risk) return res.status(404).json({ message: 'سجل الخطر غير موجود' });

    const supervisor = isSupervisor(req);
    const canRequest =
      supervisor ||
      risk.ownerUserId === req.authUser?.id ||
      risk.assigneeUserId === req.authUser?.id;
    if (!canRequest) {
      return res.status(403).json({ message: 'لا يمكنك طلب قبول هذا الخطر' });
    }
    if (risk.status === 'closed') {
      return res.status(409).json({ message: 'لا يمكن طلب قبول خطر مغلق' });
    }
    if (
      risk.status === 'accepted' &&
      risk.acceptanceExpiresAt &&
      new Date(risk.acceptanceExpiresAt).getTime() > Date.now()
    ) {
      return res.status(409).json({ message: 'الخطر مقبول حاليًا حتى انتهاء مدة القبول المعتمدة' });
    }
    if (risk.acceptanceRequests.length) {
      return res.status(409).json({ message: 'يوجد طلب قبول معلق لهذا الخطر بالفعل' });
    }

    const requestedUntil = toDate(input.requestedUntil, 'تاريخ انتهاء قبول الخطر');
    const now = new Date();
    const riskPolicy = await getEffectiveRiskPolicy(now);
    const appetiteLimit = getRiskAppetiteLimit(riskPolicy, risk.category);
    const maxUntil = new Date(now.getTime() + 365 * 86400000);
    if (requestedUntil.getTime() <= now.getTime()) {
      return res.status(400).json({ message: 'تاريخ انتهاء القبول يجب أن يكون في المستقبل' });
    }
    if (requestedUntil.getTime() > maxUntil.getTime()) {
      return res.status(400).json({ message: 'مدة قبول الخطر لا يمكن أن تتجاوز سنة واحدة' });
    }
    if (risk.residualScore > appetiteLimit && !(input.compensatingControls || []).length) {
      return res.status(400).json({
        message: `الخطر خارج شهية المخاطر المعتمدة لفئته (الحد ${appetiteLimit}/25)؛ يلزم تحديد ضابط تعويضي واحد على الأقل قبل طلب القبول`,
      });
    }

    const requestedBy = actor(req);
    const request = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpRiskAcceptanceRequest.create({
        data: {
          riskId: risk.id,
          justification: input.justification,
          compensatingControls: input.compensatingControls || [],
          requestedUntil,
          requestedById: requestedBy.id,
          requestedByName: requestedBy.name,
        },
        include: {
          risk: {
            select: {
              id: true,
              riskNumber: true,
              title: true,
              category: true,
              ownerUserId: true,
              ownerName: true,
              residualScore: true,
              residualLevel: true,
              status: true,
            },
          },
        },
      });

      await tx.transactionFollowUpRiskRegisterEvent.create({
        data: {
          riskId: risk.id,
          action: 'acceptance_requested',
          fromStatus: risk.status,
          toStatus: risk.status,
          residualProbability: risk.residualProbability,
          residualImpact: risk.residualImpact,
          residualScore: risk.residualScore,
          residualLevel: risk.residualLevel,
          note: `طلب قبول الخطر حتى ${saudiDayKey(requestedUntil)}: ${input.justification}`,
          changedById: requestedBy.id,
          changedByName: requestedBy.name,
        },
      });

      return row;
    });

    const supervisorIds = await getFollowUpSupervisorIds();
    const requestRecipients = new Set([risk.ownerUserId, ...supervisorIds].filter(Boolean));
    for (const userId of requestRecipients) {
      if (userId === requestedBy.id) continue;
      await createFollowUpAlert({
        alertKey: `risk:${risk.id}:acceptance_pending:${request.id}:${userId}`,
        transactionId: null,
        userId,
        kind: 'risk_acceptance_pending',
        severity: risk.residualScore > 9 ? 'danger' : 'warning',
        title: 'طلب اعتماد قبول خطر',
        message: `${risk.riskNumber} — ${risk.title}. طلب قبول حتى ${saudiDayKey(requestedUntil)} بانتظار القرار الإداري.`,
      });
    }

    res.status(201).json(request);
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/risk-acceptances/:id/decision', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'اعتماد أو رفض قبول المخاطر متاح للمستخدم الإشرافي فقط' });
    }

    const input = riskAcceptanceDecisionSchema.parse(req.body);
    const request = await prisma.transactionFollowUpRiskAcceptanceRequest.findUnique({
      where: { id: req.params.id },
      include: { risk: true },
    });
    if (!request) return res.status(404).json({ message: 'طلب قبول الخطر غير موجود' });
    if (request.status !== 'pending') {
      return res.status(409).json({ message: 'تم البت في طلب قبول الخطر مسبقًا' });
    }

    const reviewer = actor(req);
    if (request.requestedById === reviewer.id) {
      const supervisorIds = await getFollowUpSupervisorIds();
      const hasOtherApprover = supervisorIds.some((id) => id !== reviewer.id);
      if (hasOtherApprover || req.authUser?.role !== 'admin') {
        return res.status(409).json({
          message: 'لا يمكن لمقدم طلب قبول الخطر اعتماد طلبه؛ يلزم اعتماد مشرف آخر',
        });
      }
    }

    const now = new Date();
    const requestedUntilDay = dayNumberFromKey(saudiDayKey(new Date(request.requestedUntil)));
    const todayDay = dayNumberFromKey(saudiDayKey(now));
    if (requestedUntilDay < todayDay) {
      await prisma.$transaction(async (tx) => {
        await tx.transactionFollowUpRiskAcceptanceRequest.update({
          where: { id: request.id },
          data: { status: 'expired', expiredAt: now },
        });
        await tx.transactionFollowUpRiskRegisterEvent.create({
          data: {
            riskId: request.riskId,
            action: 'acceptance_request_expired',
            fromStatus: request.risk.status,
            toStatus: request.risk.status,
            residualProbability: request.risk.residualProbability,
            residualImpact: request.risk.residualImpact,
            residualScore: request.risk.residualScore,
            residualLevel: request.risk.residualLevel,
            note: 'انتهت صلاحية طلب قبول الخطر قبل اتخاذ قرار الاعتماد.',
            changedById: reviewer.id,
            changedByName: reviewer.name,
          },
        });
      });
      return res.status(409).json({ message: 'انتهت مدة القبول المطلوبة قبل اتخاذ القرار؛ أنشئ طلبًا جديدًا' });
    }

    const approved = input.decision === 'approved';
    const currentRisk = request.risk;
    const nextReviewDate = approved
      ? (
          currentRisk.reviewDate &&
          new Date(currentRisk.reviewDate).getTime() < new Date(request.requestedUntil).getTime()
            ? currentRisk.reviewDate
            : request.requestedUntil
        )
      : currentRisk.reviewDate;

    const updatedRequest = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpRiskAcceptanceRequest.update({
        where: { id: request.id },
        data: {
          status: input.decision,
          reviewedById: reviewer.id,
          reviewedByName: reviewer.name,
          reviewComment: input.reviewComment,
          decisionAt: now,
        },
        include: {
          risk: {
            select: {
              id: true,
              riskNumber: true,
              title: true,
              ownerUserId: true,
              ownerName: true,
              residualScore: true,
              residualLevel: true,
              status: true,
              acceptanceExpiresAt: true,
            },
          },
        },
      });

      if (approved) {
        await tx.transactionFollowUpRiskRegister.update({
          where: { id: currentRisk.id },
          data: {
            status: 'accepted',
            acceptanceExpiresAt: request.requestedUntil,
            acceptanceApprovedAt: now,
            acceptanceApprovedById: reviewer.id,
            acceptanceApprovedByName: reviewer.name,
            acceptanceReason: request.justification,
            reviewDate: nextReviewDate,
            updatedById: reviewer.id,
            updatedByName: reviewer.name,
          },
        });
      }

      await tx.transactionFollowUpRiskRegisterEvent.create({
        data: {
          riskId: currentRisk.id,
          action: approved ? 'acceptance_approved' : 'acceptance_rejected',
          fromStatus: currentRisk.status,
          toStatus: approved ? 'accepted' : currentRisk.status,
          residualProbability: currentRisk.residualProbability,
          residualImpact: currentRisk.residualImpact,
          residualScore: currentRisk.residualScore,
          residualLevel: currentRisk.residualLevel,
          note: `${approved ? 'اعتماد' : 'رفض'} قبول الخطر: ${input.reviewComment}`,
          changedById: reviewer.id,
          changedByName: reviewer.name,
        },
      });

      return row;
    });

    const recipients = new Set([
      request.requestedById,
      currentRisk.ownerUserId,
    ].filter(Boolean));
    for (const userId of recipients) {
      await createFollowUpAlert({
        alertKey: `risk:${currentRisk.id}:acceptance_${input.decision}:${request.id}:${userId}`,
        transactionId: null,
        userId,
        kind: approved ? 'risk_acceptance_approved' : 'risk_acceptance_rejected',
        severity: approved ? 'info' : 'warning',
        title: approved ? 'تم اعتماد قبول الخطر' : 'تم رفض طلب قبول الخطر',
        message: approved
          ? `${currentRisk.riskNumber} — تم قبول الخطر حتى ${saudiDayKey(new Date(request.requestedUntil))}.`
          : `${currentRisk.riskNumber} — تم رفض طلب القبول. ${input.reviewComment}`,
      });
    }

    res.json(updatedRequest);
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/risk-acceptances/:id/cancel', async (req, res, next) => {
  try {
    const request = await prisma.transactionFollowUpRiskAcceptanceRequest.findUnique({
      where: { id: req.params.id },
      include: { risk: true },
    });
    if (!request) return res.status(404).json({ message: 'طلب قبول الخطر غير موجود' });
    if (request.status !== 'pending') {
      return res.status(409).json({ message: 'لا يمكن إلغاء طلب تم البت فيه' });
    }
    const supervisor = isSupervisor(req);
    if (!supervisor && request.requestedById !== req.authUser?.id) {
      return res.status(403).json({ message: 'لا يمكنك إلغاء هذا الطلب' });
    }

    const changedBy = actor(req);
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpRiskAcceptanceRequest.update({
        where: { id: request.id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
        },
        include: { risk: true },
      });
      await tx.transactionFollowUpRiskRegisterEvent.create({
        data: {
          riskId: request.riskId,
          action: 'acceptance_cancelled',
          fromStatus: request.risk.status,
          toStatus: request.risk.status,
          residualProbability: request.risk.residualProbability,
          residualImpact: request.risk.residualImpact,
          residualScore: request.risk.residualScore,
          residualLevel: request.risk.residualLevel,
          note: 'إلغاء طلب قبول الخطر قبل اتخاذ القرار',
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

router.get('/directives/risk-dashboard', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'لوحة المخاطر التنفيذية متاحة للمستخدم الإشرافي فقط' });
    }

    const now = new Date();
    const riskPolicy = await getEffectiveRiskPolicy(now);
    const appetiteMaxScore = riskPolicy.appetiteMaxScore;
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const preventiveStart = new Date(now.getTime() - 90 * 86400000);

    const [
      activeRisks,
      riskEvents,
      preventiveActions,
      improvementPlans,
      riskAcceptances,
      earlyWarning,
    ] = await Promise.all([
      prisma.transactionFollowUpRiskRegister.findMany({
        where: { status: { not: 'closed' } },
        orderBy: [{ residualScore: 'desc' }, { reviewDate: 'asc' }, { createdAt: 'desc' }],
      }),
      prisma.transactionFollowUpRiskRegisterEvent.findMany({
        where: { createdAt: { gte: trendStart } },
        select: {
          action: true,
          toStatus: true,
          residualScore: true,
          residualLevel: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.transactionFollowUpPreventiveAction.findMany({
        where: { createdAt: { gte: preventiveStart } },
        select: {
          id: true,
          status: true,
          dueDate: true,
          createdAt: true,
        },
      }),
      prisma.transactionFollowUpImprovementPlan.findMany({
        where: {
          status: { in: ['open', 'in_progress', 'monitoring'] },
        },
        select: {
          id: true,
          status: true,
          dueDate: true,
          resultMetTarget: true,
          verifiedAt: true,
        },
      }),
      prisma.transactionFollowUpRiskAcceptanceRequest.findMany({
        where: {
          OR: [
            { status: { in: ['pending', 'approved'] } },
            { decisionAt: { gte: new Date(now.getTime() - 30 * 86400000) } },
            { expiredAt: { gte: new Date(now.getTime() - 30 * 86400000) } },
          ],
        },
        include: {
          risk: {
            select: {
              id: true,
              riskNumber: true,
              title: true,
              residualScore: true,
              residualLevel: true,
              status: true,
            },
          },
        },
      }),
      (async () => {
        const targets = await getKpiTargets();
        return buildEarlyWarningSnapshot(targets.alertPeriodDays, targets);
      })(),
    ]);

    const round = (value, digits = 1) =>
      value == null || Number.isNaN(Number(value))
        ? null
        : Number(Number(value).toFixed(digits));
    const averageOf = (values) =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const percent = (part, total) => total ? round((part / total) * 100) : 0;
    const monthKey = (date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    const critical = activeRisks.filter((risk) => risk.residualLevel === 'critical').length;
    const high = activeRisks.filter((risk) => risk.residualLevel === 'high').length;
    const medium = activeRisks.filter((risk) => risk.residualLevel === 'medium').length;
    const low = activeRisks.filter((risk) => risk.residualLevel === 'low').length;
    const outsideAppetite = activeRisks.filter(
      (risk) => risk.residualScore > getRiskAppetiteLimit(riskPolicy, risk.category)
    ).length;
    const overdueReview = activeRisks.filter(
      (risk) => risk.reviewDate && new Date(risk.reviewDate).getTime() < now.getTime()
    ).length;
    const recurring = activeRisks.filter((risk) => risk.recurrenceCount > 0).length;
    const accepted = activeRisks.filter((risk) => risk.status === 'accepted').length;
    const controlled = activeRisks.filter((risk) => risk.status === 'controlled').length;

    const inherentScores = activeRisks.map((risk) => risk.inherentScore);
    const residualScores = activeRisks.map((risk) => risk.residualScore);
    const reductions = activeRisks
      .filter((risk) => risk.inherentScore > 0)
      .map((risk) => ((risk.inherentScore - risk.residualScore) / risk.inherentScore) * 100);
    const treated = activeRisks.filter((risk) => {
      const controls = Array.isArray(risk.controls) ? risk.controls.filter(Boolean) : [];
      return Boolean(risk.treatmentPlan?.trim()) || controls.length > 0;
    }).length;

    const outsideAppetiteRate = percent(outsideAppetite, activeRisks.length);
    const overdueReviewRate = percent(overdueReview, activeRisks.length);
    const recurringRiskRate = percent(recurring, activeRisks.length);
    const avgRiskReductionPercent = round(averageOf(reductions));

    const preventiveFailed = preventiveActions.filter((item) => item.status === 'failed').length;
    const preventiveEffective = preventiveActions.filter((item) => item.status === 'effective').length;
    const preventiveVerified = preventiveFailed + preventiveEffective;
    const preventiveFailureRate = percent(preventiveFailed, preventiveVerified);
    const preventiveOverdue = preventiveActions.filter(
      (item) =>
        ['open', 'in_progress', 'monitoring'].includes(item.status) &&
        item.dueDate &&
        new Date(item.dueDate).getTime() < now.getTime()
    ).length;

    const capaOverdue = improvementPlans.filter(
      (plan) => plan.dueDate && new Date(plan.dueDate).getTime() < now.getTime()
    ).length;

    const dashboardTodayNumber = dayNumberFromKey(saudiDayKey(now));
    const acceptancePending = riskAcceptances.filter((item) => item.status === 'pending').length;
    const acceptanceActive = riskAcceptances.filter(
      (item) =>
        item.status === 'approved' &&
        item.risk?.status === 'accepted' &&
        dayNumberFromKey(saudiDayKey(new Date(item.requestedUntil))) >= dashboardTodayNumber
    ).length;
    const acceptanceExpiringSoon = riskAcceptances.filter((item) => {
      if (item.status !== 'approved' || item.risk?.status !== 'accepted') return false;
      const untilNumber = dayNumberFromKey(saudiDayKey(new Date(item.requestedUntil)));
      const daysUntil = untilNumber - dashboardTodayNumber;
      return daysUntil >= 0 && daysUntil <= 7;
    }).length;
    const acceptanceRejected30d = riskAcceptances.filter(
      (item) =>
        item.status === 'rejected' &&
        item.decisionAt &&
        new Date(item.decisionAt).getTime() >= now.getTime() - 30 * 86400000
    ).length;
    const acceptanceExpired30d = riskAcceptances.filter(
      (item) =>
        item.status === 'expired' &&
        item.expiredAt &&
        new Date(item.expiredAt).getTime() >= now.getTime() - 30 * 86400000
    ).length;
    const acceptedOutsideAppetite = activeRisks.filter(
      (risk) =>
        risk.status === 'accepted' &&
        risk.residualScore > getRiskAppetiteLimit(riskPolicy, risk.category)
    ).length;

    const outsideAppetiteStatus = evaluateRiskKriStatus(
      outsideAppetiteRate,
      getRiskKriThreshold(riskPolicy, 'outsideAppetiteRate'),
    );
    const criticalRiskStatus = evaluateRiskKriStatus(
      critical,
      getRiskKriThreshold(riskPolicy, 'criticalRisks'),
    );
    const riskAppetiteStatus =
      outsideAppetiteStatus === 'red' || criticalRiskStatus === 'red'
        ? 'breached'
        : outsideAppetiteStatus === 'yellow' || criticalRiskStatus === 'yellow'
          ? 'watch'
          : 'within';

    const kriDefinition = (key, label, value, unit, description) => {
      const threshold = getRiskKriThreshold(riskPolicy, key);
      return {
        key,
        label,
        value,
        unit,
        status: evaluateRiskKriStatus(value, threshold),
        target: riskKriTargetLabel(threshold, unit),
        threshold,
        description,
      };
    };

    const kri = [
      kriDefinition(
        'outsideAppetiteRate',
        'المخاطر خارج شهية المخاطر',
        outsideAppetiteRate,
        '%',
        'نسبة المخاطر النشطة التي تجاوز خطرها المتبقي حد شهية المخاطر المعتمد للفئة.',
      ),
      kriDefinition(
        'criticalRisks',
        'المخاطر الحرجة',
        critical,
        'خطر',
        'عدد المخاطر النشطة المصنفة حرجة بعد تطبيق الضوابط.',
      ),
      kriDefinition(
        'overdueReviewRate',
        'تأخر مراجعة المخاطر',
        overdueReviewRate,
        '%',
        'نسبة المخاطر النشطة التي تجاوزت تاريخ المراجعة المحدد.',
      ),
      kriDefinition(
        'recurringRiskRate',
        'تكرار المخاطر',
        recurringRiskRate,
        '%',
        'نسبة المخاطر النشطة التي تم تسجيل تكرار لها مرة واحدة على الأقل.',
      ),
      kriDefinition(
        'riskReduction',
        'فعالية خفض المخاطر',
        avgRiskReductionPercent,
        '%',
        'متوسط الانخفاض من الخطر الكامن إلى الخطر المتبقي.',
      ),
      kriDefinition(
        'preventiveFailureRate',
        'فشل التدخلات الوقائية',
        preventiveFailureRate,
        '%',
        'نسبة التدخلات الوقائية غير الفعالة من التدخلات التي تم التحقق من أثرها خلال آخر 90 يومًا.',
      ),
      kriDefinition(
        'predictedBreaches',
        'تجاوزات KPI المتوقعة',
        earlyWarning.summary.predictedMetricBreaches,
        'مؤشر',
        'عدد مؤشرات الأداء المتوقع انتقالها إلى المستوى الأحمر إذا استمر الاتجاه الحالي.',
      ),
      kriDefinition(
        'capaOverdue',
        'خطط CAPA المتأخرة',
        capaOverdue,
        'خطة',
        'عدد خطط التحسين المفتوحة التي تجاوزت تاريخ الاستحقاق.',
      ),
      kriDefinition(
        'pendingRiskAcceptances',
        'طلبات قبول مخاطر معلقة',
        acceptancePending,
        'طلب',
        'طلبات قبول المخاطر التي ما زالت بانتظار قرار إداري.',
      ),
      kriDefinition(
        'expiringRiskAcceptances',
        'قبول مخاطر يقترب من الانتهاء',
        acceptanceExpiringSoon,
        'خطر',
        'المخاطر المقبولة التي تنتهي مدة قبولها خلال سبعة أيام.',
      ),
    ];

    const ownerMap = new Map();
    const categoryMap = new Map();
    const statusMap = new Map();
    const treatmentMap = new Map();

    for (const risk of activeRisks) {
      const ownerKey = risk.ownerUserId || risk.ownerName || 'unknown';
      if (!ownerMap.has(ownerKey)) {
        ownerMap.set(ownerKey, {
          ownerUserId: risk.ownerUserId || null,
          ownerName: risk.ownerName || 'غير محدد',
          active: 0,
          outsideAppetite: 0,
          overdueReview: 0,
          totalResidualScore: 0,
          totalReduction: 0,
          reductionSamples: 0,
        });
      }
      const owner = ownerMap.get(ownerKey);
      owner.active += 1;
      owner.totalResidualScore += risk.residualScore;
      if (risk.residualScore > getRiskAppetiteLimit(riskPolicy, risk.category)) owner.outsideAppetite += 1;
      if (risk.reviewDate && new Date(risk.reviewDate).getTime() < now.getTime()) owner.overdueReview += 1;
      if (risk.inherentScore > 0) {
        owner.totalReduction += ((risk.inherentScore - risk.residualScore) / risk.inherentScore) * 100;
        owner.reductionSamples += 1;
      }

      const category = categoryMap.get(risk.category) || {
        category: risk.category,
        active: 0,
        outsideAppetite: 0,
        totalResidualScore: 0,
      };
      category.active += 1;
      category.totalResidualScore += risk.residualScore;
      if (risk.residualScore > getRiskAppetiteLimit(riskPolicy, risk.category)) category.outsideAppetite += 1;
      categoryMap.set(risk.category, category);

      statusMap.set(risk.status, (statusMap.get(risk.status) || 0) + 1);
      treatmentMap.set(
        risk.treatmentStrategy,
        (treatmentMap.get(risk.treatmentStrategy) || 0) + 1
      );
    }

    const owners = Array.from(ownerMap.values())
      .map((owner) => ({
        ownerUserId: owner.ownerUserId,
        ownerName: owner.ownerName,
        active: owner.active,
        outsideAppetite: owner.outsideAppetite,
        overdueReview: owner.overdueReview,
        averageResidualScore: round(owner.totalResidualScore / owner.active),
        riskReductionPercent: owner.reductionSamples
          ? round(owner.totalReduction / owner.reductionSamples)
          : null,
      }))
      .sort((a, b) =>
        (b.outsideAppetite - a.outsideAppetite) ||
        (b.averageResidualScore - a.averageResidualScore) ||
        (b.active - a.active)
      );

    const categories = Array.from(categoryMap.values())
      .map((item) => ({
        category: item.category,
        active: item.active,
        outsideAppetite: item.outsideAppetite,
        averageResidualScore: round(item.totalResidualScore / item.active),
      }))
      .sort((a, b) => (b.outsideAppetite - a.outsideAppetite) || (b.active - a.active));

    const trend = [];
    for (let offset = 5; offset >= 0; offset -= 1) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const key = monthKey(monthStart);
      const monthEvents = riskEvents.filter((event) => monthKey(new Date(event.createdAt)) === key);
      trend.push({
        key,
        year: monthStart.getFullYear(),
        month: monthStart.getMonth() + 1,
        created: monthEvents.filter((event) => event.action === 'created').length,
        closed: monthEvents.filter(
          (event) => event.action === 'status_changed' && event.toStatus === 'closed'
        ).length,
        reassessed: monthEvents.filter((event) => event.action === 'reassessed').length,
        highCriticalAssessments: monthEvents.filter(
          (event) => ['high', 'critical'].includes(event.residualLevel)
        ).length,
      });
    }

    const topRisks = activeRisks.slice(0, 10).map((risk) => ({
      id: risk.id,
      riskNumber: risk.riskNumber,
      title: risk.title,
      category: risk.category,
      ownerUserId: risk.ownerUserId,
      ownerName: risk.ownerName,
      status: risk.status,
      inherentScore: risk.inherentScore,
      residualScore: risk.residualScore,
      residualLevel: risk.residualLevel,
      recurrenceCount: risk.recurrenceCount,
      reviewDate: risk.reviewDate,
      isReviewOverdue: Boolean(
        risk.reviewDate && new Date(risk.reviewDate).getTime() < now.getTime()
      ),
      treatmentStrategy: risk.treatmentStrategy,
      appetiteLimit: getRiskAppetiteLimit(riskPolicy, risk.category),
      outsideAppetite: risk.residualScore > getRiskAppetiteLimit(riskPolicy, risk.category),
    }));

    res.json({
      generatedAt: now,
      appetite: {
        policyId: riskPolicy.id,
        versionNumber: riskPolicy.versionNumber,
        policyName: riskPolicy.name,
        effectiveFrom: riskPolicy.effectiveFrom,
        maxResidualScore: appetiteMaxScore,
        categoryLimits: riskPolicy.categoryAppetite,
        level: riskMatrixLevelFromScore(appetiteMaxScore),
        status: riskAppetiteStatus,
        withinCount: Math.max(0, activeRisks.length - outsideAppetite),
        outsideCount: outsideAppetite,
        outsideRate: outsideAppetiteRate,
        statement: riskPolicy.statement,
      },
      summary: {
        active: activeRisks.length,
        critical,
        high,
        medium,
        low,
        outsideAppetite,
        overdueReview,
        recurring,
        accepted,
        controlled,
        averageInherentScore: round(averageOf(inherentScores)),
        averageResidualScore: round(averageOf(residualScores)),
        averageRiskReductionPercent: avgRiskReductionPercent,
        treatmentCoveragePercent: percent(treated, activeRisks.length),
      },
      kri,
      topRisks,
      owners: owners.slice(0, 12),
      categories,
      statuses: Array.from(statusMap.entries()).map(([status, count]) => ({ status, count })),
      treatmentStrategies: Array.from(treatmentMap.entries()).map(([strategy, count]) => ({ strategy, count })),
      trend,
      earlyWarning: {
        summary: earlyWarning.summary,
        metrics: earlyWarning.metrics
          .filter((metric) => ['yellow', 'red'].includes(metric.currentStatus) || ['yellow', 'red'].includes(metric.projectedStatus))
          .slice(0, 5),
        employees: earlyWarning.employees
          .filter((employee) => ['high', 'critical'].includes(employee.riskLevel))
          .slice(0, 5),
      },
      preventive: {
        periodDays: 90,
        total: preventiveActions.length,
        verified: preventiveVerified,
        effective: preventiveEffective,
        failed: preventiveFailed,
        overdue: preventiveOverdue,
        failureRate: preventiveFailureRate,
      },
      capa: {
        open: improvementPlans.length,
        overdue: capaOverdue,
      },
      acceptance: {
        pending: acceptancePending,
        activeApproved: acceptanceActive,
        expiringSoon: acceptanceExpiringSoon,
        rejected30d: acceptanceRejected30d,
        expired30d: acceptanceExpired30d,
        acceptedOutsideAppetite,
      },
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

    const riskPolicy = await getEffectiveRiskPolicy();
    res.status(201).json(serializeRisk(risk, riskPolicy));
  } catch (error) {
    next(error);
  }
});

router.patch('/directives/risks/:id', async (req, res, next) => {
  try {
    const input = riskRegisterUpdateSchema.parse(req.body);
    if (input.status === 'accepted') {
      return res.status(409).json({
        message: 'لا يمكن قبول الخطر مباشرة؛ أنشئ طلب قبول واعتمده عبر مسار الحوكمة',
      });
    }
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
    if (current.status === 'accepted' && input.status && input.status !== 'closed') {
      return res.status(409).json({
        message: 'حالة الخطر المقبول محكومة بقرار القبول؛ لا يمكن تغييرها مباشرة قبل انتهاء القبول أو إغلاق الخطر',
      });
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
    const residualLevel = riskMatrixLevelFromScore(residualScore);
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

      if (current.status === 'accepted' && input.status === 'closed') {
        await tx.transactionFollowUpRiskAcceptanceRequest.updateMany({
          where: {
            riskId: current.id,
            status: 'approved',
          },
          data: {
            status: 'expired',
            expiredAt: new Date(),
          },
        });
      }

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

    const riskPolicy = await getEffectiveRiskPolicy();
    res.json(serializeRisk(updated, riskPolicy));
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

router.get('/external-waits', async (req, res, next) => {
  try {
    const supervisor = isSupervisor(req);
    const status = String(req.query.status || 'active').trim();
    const allowedStatuses = ['active', 'responded', 'cancelled'];
    const where = {
      ...(allowedStatuses.includes(status) ? { status } : {}),
      ...(!supervisor ? { transaction: { currentAssigneeUserId: req.authUser.id } } : {}),
    };
    const rows = await prisma.transactionFollowUpExternalWait.findMany({
      where,
      include: {
        transaction: {
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
          },
        },
      },
      orderBy: [{ nextFollowUpDate: 'asc' }, { createdAt: 'desc' }],
      take: 150,
    });
    const todayNumber = dayNumberFromKey(saudiDayKey());
    res.json(rows.map((row) => {
      const sentNumber = dayNumberFromKey(saudiDayKey(new Date(row.sentAt)));
      const followUpNumber = dayNumberFromKey(saudiDayKey(new Date(row.nextFollowUpDate)));
      return {
        ...row,
        waitingDays: Math.max(0, todayNumber - sentNumber),
        daysUntilFollowUp: followUpNumber - todayNumber,
        followUpDue: row.status === 'active' && followUpNumber <= todayNumber,
      };
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/external-wait', async (req, res, next) => {
  try {
    const input = externalWaitCreateSchema.parse(req.body);
    const current = await prisma.transactionFollowUp.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (!canActOnRecord(req, current)) return denyRecordAccess(res);
    if (FINAL_STATUSES.includes(current.status)) {
      return res.status(409).json({ message: 'لا يمكن وضع معاملة منجزة أو مغلقة في انتظار جهة أخرى' });
    }

    const existing = await prisma.transactionFollowUpExternalWait.findFirst({
      where: { transactionId: current.id, status: 'active' },
    });
    if (existing) {
      return res.status(409).json({ message: 'المعاملة مسجلة بالفعل بانتظار رد من جهة أخرى' });
    }

    const sentAt = toDate(input.sentAt, 'تاريخ إرسال الطلب');
    const nextFollowUpDate = toDate(input.nextFollowUpDate, 'تاريخ المتابعة القادمة');
    const todayNumber = dayNumberFromKey(saudiDayKey());
    const sentNumber = dayNumberFromKey(saudiDayKey(sentAt));
    const followUpNumber = dayNumberFromKey(saudiDayKey(nextFollowUpDate));

    if (sentNumber > todayNumber) {
      return res.status(400).json({ message: 'تاريخ إرسال الطلب لا يمكن أن يكون في المستقبل' });
    }
    if (followUpNumber <= todayNumber) {
      return res.status(400).json({ message: 'تاريخ المتابعة القادمة يجب أن يكون بعد تاريخ اليوم' });
    }

    const changedBy = actor(req);
    const changedAt = new Date();
    const wait = await prisma.$transaction(async (tx) => {
      const created = await tx.transactionFollowUpExternalWait.create({
        data: {
          transactionId: current.id,
          externalEntity: input.externalEntity,
          outboundReferenceNumber: input.outboundReferenceNumber || null,
          sentAt,
          nextFollowUpDate,
          notes: input.notes || null,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });
      await tx.transactionFollowUp.update({
        where: { id: current.id },
        data: {
          status: 'waiting_response',
          lastActionAt: changedAt,
          lastActionByUserId: changedBy.id,
          lastActionByName: changedBy.name,
        },
      });
      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: current.id,
          eventType: 'external_wait_started',
          fromStatus: current.status,
          toStatus: 'waiting_response',
          actionText: `بانتظار رد من ${input.externalEntity} — المتابعة القادمة ${saudiDayKey(nextFollowUpDate)}`,
          note: [
            input.outboundReferenceNumber ? `المرجع: ${input.outboundReferenceNumber}` : null,
            input.notes || null,
          ].filter(Boolean).join(' — ') || null,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });
      return created;
    });

    res.status(201).json(wait);
  } catch (error) {
    next(error);
  }
});

router.patch('/external-waits/:id/follow-up', async (req, res, next) => {
  try {
    const input = externalWaitFollowUpSchema.parse(req.body);
    const wait = await prisma.transactionFollowUpExternalWait.findUnique({
      where: { id: req.params.id },
      include: { transaction: true },
    });
    if (!wait) return res.status(404).json({ message: 'سجل انتظار الجهة غير موجود' });
    if (!canActOnRecord(req, wait.transaction)) return denyRecordAccess(res);
    if (wait.status !== 'active') {
      return res.status(409).json({ message: 'تم إنهاء حالة الانتظار ولا يمكن تسجيل متابعة جديدة عليها' });
    }

    const nextFollowUpDate = toDate(input.nextFollowUpDate, 'تاريخ المتابعة القادمة');
    const todayNumber = dayNumberFromKey(saudiDayKey());
    const nextNumber = dayNumberFromKey(saudiDayKey(nextFollowUpDate));
    if (nextNumber <= todayNumber) {
      return res.status(400).json({ message: 'تاريخ المتابعة القادمة يجب أن يكون بعد تاريخ اليوم' });
    }

    const changedBy = actor(req);
    const changedAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpExternalWait.update({
        where: { id: wait.id },
        data: {
          nextFollowUpDate,
          lastFollowUpAt: changedAt,
          lastFollowUpNote: input.note,
          followUpCount: { increment: 1 },
        },
      });
      await tx.transactionFollowUp.update({
        where: { id: wait.transactionId },
        data: {
          lastActionAt: changedAt,
          lastActionByUserId: changedBy.id,
          lastActionByName: changedBy.name,
        },
      });
      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: wait.transactionId,
          eventType: 'external_follow_up_recorded',
          fromStatus: wait.transaction.status,
          toStatus: wait.transaction.status,
          actionText: `متابعة مع ${wait.externalEntity} — الموعد القادم ${saudiDayKey(nextFollowUpDate)}`,
          note: input.note,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });
      return row;
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch('/external-waits/:id/response', async (req, res, next) => {
  try {
    const input = externalWaitResponseSchema.parse(req.body);
    const wait = await prisma.transactionFollowUpExternalWait.findUnique({
      where: { id: req.params.id },
      include: { transaction: true },
    });
    if (!wait) return res.status(404).json({ message: 'سجل انتظار الجهة غير موجود' });
    if (!canActOnRecord(req, wait.transaction)) return denyRecordAccess(res);
    if (wait.status !== 'active') {
      return res.status(409).json({ message: 'حالة الانتظار منتهية مسبقًا' });
    }

    const responseReceivedAt = toDate(input.responseReceivedAt, 'تاريخ ورود الرد');
    const todayNumber = dayNumberFromKey(saudiDayKey());
    const responseNumber = dayNumberFromKey(saudiDayKey(responseReceivedAt));
    const sentNumber = dayNumberFromKey(saudiDayKey(new Date(wait.sentAt)));
    if (responseNumber > todayNumber) {
      return res.status(400).json({ message: 'تاريخ ورود الرد لا يمكن أن يكون في المستقبل' });
    }
    if (responseNumber < sentNumber) {
      return res.status(400).json({ message: 'تاريخ ورود الرد لا يمكن أن يسبق تاريخ إرسال الطلب' });
    }

    const changedBy = actor(req);
    const changedAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpExternalWait.update({
        where: { id: wait.id },
        data: {
          status: 'responded',
          responseReceivedAt,
          responseReferenceNumber: input.responseReferenceNumber || null,
          responseNote: input.responseNote,
          closedById: changedBy.id,
          closedByName: changedBy.name,
          closedAt: changedAt,
        },
      });
      await tx.transactionFollowUp.update({
        where: { id: wait.transactionId },
        data: {
          status: 'in_progress',
          lastActionAt: changedAt,
          lastActionByUserId: changedBy.id,
          lastActionByName: changedBy.name,
        },
      });
      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: wait.transactionId,
          eventType: 'external_response_received',
          fromStatus: wait.transaction.status,
          toStatus: 'in_progress',
          actionText: `ورود رد من ${wait.externalEntity} واستئناف تنفيذ المعاملة`,
          note: [
            input.responseReferenceNumber ? `مرجع الرد: ${input.responseReferenceNumber}` : null,
            input.responseNote,
          ].filter(Boolean).join(' — '),
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });
      return row;
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch('/external-waits/:id/cancel', async (req, res, next) => {
  try {
    const input = externalWaitCancelSchema.parse(req.body);
    const wait = await prisma.transactionFollowUpExternalWait.findUnique({
      where: { id: req.params.id },
      include: { transaction: true },
    });
    if (!wait) return res.status(404).json({ message: 'سجل انتظار الجهة غير موجود' });
    if (!canActOnRecord(req, wait.transaction)) return denyRecordAccess(res);
    if (wait.status !== 'active') {
      return res.status(409).json({ message: 'حالة الانتظار منتهية مسبقًا' });
    }

    const changedBy = actor(req);
    const changedAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUpExternalWait.update({
        where: { id: wait.id },
        data: {
          status: 'cancelled',
          responseNote: input.note,
          closedById: changedBy.id,
          closedByName: changedBy.name,
          closedAt: changedAt,
        },
      });
      await tx.transactionFollowUp.update({
        where: { id: wait.transactionId },
        data: {
          status: 'in_progress',
          lastActionAt: changedAt,
          lastActionByUserId: changedBy.id,
          lastActionByName: changedBy.name,
        },
      });
      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: wait.transactionId,
          eventType: 'external_wait_cancelled',
          fromStatus: wait.transaction.status,
          toStatus: 'in_progress',
          actionText: `إلغاء انتظار الرد من ${wait.externalEntity} واستئناف العمل`,
          note: input.note,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });
      return row;
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get('/extension-requests', async (req, res, next) => {
  try {
    const supervisor = isSupervisor(req);
    const status = String(req.query.status || 'pending').trim();
    const allowedStatuses = ['pending', 'approved', 'rejected', 'cancelled'];
    const where = {
      ...(allowedStatuses.includes(status) ? { status } : {}),
      ...(!supervisor
        ? {
            OR: [
              { requestedById: req.authUser.id },
              { transaction: { currentAssigneeUserId: req.authUser.id } },
            ],
          }
        : {}),
    };

    const rows = await prisma.transactionFollowUpExtensionRequest.findMany({
      where,
      include: {
        transaction: {
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
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/extension-requests', async (req, res, next) => {
  try {
    const input = extensionRequestCreateSchema.parse(req.body);
    const current = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (!canActOnRecord(req, current)) return denyRecordAccess(res);
    if (FINAL_STATUSES.includes(current.status)) {
      return res.status(409).json({
        message: 'المعاملة منجزة أو مغلقة. يجب على مستخدم يملك صلاحية «إعادة فتح المعاملة» فتحها أولًا ثم تقديم طلب التمديد.',
      });
    }
    if (!current.dueDate) {
      return res.status(409).json({ message: 'لا يوجد تاريخ استحقاق حالي للمعاملة حتى يتم تمديده' });
    }

    const existingPending = await prisma.transactionFollowUpExtensionRequest.findFirst({
      where: { transactionId: current.id, status: 'pending' },
    });
    if (existingPending) {
      return res.status(409).json({ message: 'يوجد طلب تمديد معلق لهذه المعاملة بالفعل' });
    }

    const requestedDueDate = toDate(input.requestedDueDate, 'تاريخ التمديد المقترح');
    const todayNumber = dayNumberFromKey(saudiDayKey());
    const currentDueNumber = dayNumberFromKey(saudiDayKey(new Date(current.dueDate)));
    const requestedNumber = dayNumberFromKey(saudiDayKey(requestedDueDate));

    if (requestedNumber <= currentDueNumber) {
      return res.status(400).json({ message: 'تاريخ التمديد المقترح يجب أن يكون بعد تاريخ الاستحقاق الحالي' });
    }
    if (requestedNumber <= todayNumber) {
      return res.status(400).json({ message: 'تاريخ التمديد المقترح يجب أن يكون تاريخًا مستقبليًا' });
    }
    if (requestedNumber - todayNumber > 365) {
      return res.status(400).json({ message: 'مدة التمديد المقترحة لا يمكن أن تتجاوز سنة من تاريخ اليوم' });
    }

    const requestedBy = actor(req);
    const createdAt = new Date();
    const request = await prisma.$transaction(async (tx) => {
      const created = await tx.transactionFollowUpExtensionRequest.create({
        data: {
          transactionId: current.id,
          currentDueDate: current.dueDate,
          requestedDueDate,
          reason: input.reason,
          requestedById: requestedBy.id,
          requestedByName: requestedBy.name,
        },
      });

      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: current.id,
          eventType: 'extension_requested',
          fromStatus: current.status,
          toStatus: current.status,
          fromAssigneeUserId: current.currentAssigneeUserId,
          fromAssigneeName: current.currentAssigneeName,
          toAssigneeUserId: current.currentAssigneeUserId,
          toAssigneeName: current.currentAssigneeName,
          actionText: `طلب تمديد تاريخ الاستحقاق من ${saudiDayKey(new Date(current.dueDate))} إلى ${saudiDayKey(requestedDueDate)}`,
          note: input.reason,
          createdById: requestedBy.id,
          createdByName: requestedBy.name,
        },
      });

      return created;
    });

    const supervisorIds = await getFollowUpSupervisorIds();
    const overdue = currentDueNumber < todayNumber;
    for (const userId of supervisorIds) {
      if (userId === requestedBy.id) continue;
      await createFollowUpAlert({
        alertKey: `transaction:${current.id}:extension_request:${request.id}:${userId}`,
        transactionId: current.id,
        userId,
        kind: 'transaction_extension_requested',
        severity: overdue ? 'danger' : 'warning',
        title: 'طلب تمديد معاملة بانتظار الاعتماد',
        message: `${current.transactionNumber} — طلب ${requestedBy.name} تمديد الاستحقاق إلى ${saudiDayKey(requestedDueDate)}. السبب: ${input.reason}`,
      });
    }

    res.status(201).json(request);
  } catch (error) {
    next(error);
  }
});

router.patch('/extension-requests/:id/decision', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'اعتماد أو رفض طلب التمديد متاح للمستخدم الإشرافي فقط' });
    }

    const input = extensionRequestDecisionSchema.parse(req.body);
    const request = await prisma.transactionFollowUpExtensionRequest.findUnique({
      where: { id: req.params.id },
      include: { transaction: true },
    });
    if (!request) return res.status(404).json({ message: 'طلب التمديد غير موجود' });
    if (request.status !== 'pending') {
      return res.status(409).json({ message: 'تم البت في طلب التمديد مسبقًا' });
    }
    if (input.decision === 'rejected' && !input.reviewNote?.trim()) {
      return res.status(400).json({ message: 'سبب رفض طلب التمديد مطلوب' });
    }

    const reviewer = actor(req);
    if (request.requestedById === reviewer.id) {
      const supervisorIds = await getFollowUpSupervisorIds();
      const hasOtherApprover = supervisorIds.some((id) => id !== reviewer.id);
      if (hasOtherApprover || req.authUser?.role !== 'admin') {
        return res.status(409).json({ message: 'لا يمكن لمقدم طلب التمديد اعتماد طلبه؛ يلزم مراجع إشرافي آخر' });
      }
    }

    const approved = input.decision === 'approved';
    const currentDueKey = request.transaction.dueDate
      ? saudiDayKey(new Date(request.transaction.dueDate))
      : null;
    const requestBaseKey = saudiDayKey(new Date(request.currentDueDate));
    if (approved && currentDueKey !== requestBaseKey) {
      return res.status(409).json({
        message: 'تغير تاريخ استحقاق المعاملة بعد تقديم الطلب؛ يجب إلغاء الطلب الحالي وإنشاء طلب جديد',
      });
    }
    if (FINAL_STATUSES.includes(request.transaction.status)) {
      return res.status(409).json({ message: 'المعاملة منجزة أو مغلقة ولا يمكن اعتماد تمديد جديد لها' });
    }

    const decisionAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const decided = await tx.transactionFollowUpExtensionRequest.update({
        where: { id: request.id },
        data: {
          status: input.decision,
          reviewedById: reviewer.id,
          reviewedByName: reviewer.name,
          reviewNote: input.reviewNote || null,
          decisionAt,
        },
      });

      if (approved) {
        await tx.transactionFollowUp.update({
          where: { id: request.transactionId },
          data: {
            dueDate: request.requestedDueDate,
            lastActionAt: decisionAt,
            lastActionByUserId: reviewer.id,
            lastActionByName: reviewer.name,
          },
        });
      }

      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: request.transactionId,
          eventType: approved ? 'extension_approved' : 'extension_rejected',
          fromStatus: request.transaction.status,
          toStatus: request.transaction.status,
          fromAssigneeUserId: request.transaction.currentAssigneeUserId,
          fromAssigneeName: request.transaction.currentAssigneeName,
          toAssigneeUserId: request.transaction.currentAssigneeUserId,
          toAssigneeName: request.transaction.currentAssigneeName,
          actionText: approved
            ? `اعتماد تمديد تاريخ الاستحقاق من ${requestBaseKey} إلى ${saudiDayKey(new Date(request.requestedDueDate))}`
            : `رفض طلب تمديد تاريخ الاستحقاق إلى ${saudiDayKey(new Date(request.requestedDueDate))}`,
          note: input.reviewNote || request.reason,
          createdById: reviewer.id,
          createdByName: reviewer.name,
        },
      });

      return decided;
    });

    const recipients = new Set([
      request.requestedById,
      request.transaction.currentAssigneeUserId,
    ].filter(Boolean));
    for (const userId of recipients) {
      if (userId === reviewer.id) continue;
      await createFollowUpAlert({
        alertKey: `transaction:${request.transactionId}:extension_${input.decision}:${request.id}:${userId}`,
        transactionId: request.transactionId,
        userId,
        kind: approved ? 'transaction_extension_approved' : 'transaction_extension_rejected',
        severity: approved ? 'info' : 'warning',
        title: approved ? 'تم اعتماد طلب تمديد المعاملة' : 'تم رفض طلب تمديد المعاملة',
        message: approved
          ? `${request.transaction.transactionNumber} — تم تمديد تاريخ الاستحقاق إلى ${saudiDayKey(new Date(request.requestedDueDate))}.`
          : `${request.transaction.transactionNumber} — تم رفض طلب التمديد${input.reviewNote ? `: ${input.reviewNote}` : '.'}`,
      });
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch('/extension-requests/:id/cancel', async (req, res, next) => {
  try {
    const request = await prisma.transactionFollowUpExtensionRequest.findUnique({
      where: { id: req.params.id },
      include: { transaction: true },
    });
    if (!request) return res.status(404).json({ message: 'طلب التمديد غير موجود' });
    if (request.status !== 'pending') {
      return res.status(409).json({ message: 'لا يمكن إلغاء طلب تم البت فيه' });
    }
    if (!isSupervisor(req) && request.requestedById !== req.authUser.id) {
      return res.status(403).json({ message: 'لا يمكنك إلغاء طلب تمديد مقدم من مستخدم آخر' });
    }

    const changedBy = actor(req);
    const cancelledAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const cancelled = await tx.transactionFollowUpExtensionRequest.update({
        where: { id: request.id },
        data: { status: 'cancelled', cancelledAt },
      });
      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: request.transactionId,
          eventType: 'extension_cancelled',
          fromStatus: request.transaction.status,
          toStatus: request.transaction.status,
          actionText: 'إلغاء طلب تمديد تاريخ الاستحقاق',
          note: request.reason,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });
      return cancelled;
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get('/work-queue', async (req, res, next) => {
  try {
    const supervisor = isSupervisor(req);
    const reopenAllowed = canReopenRecord(req);
    const mineRequested = String(req.query.mine || '').toLowerCase() === 'true';
    const mine = !supervisor || mineRequested;
    const baseWhere = {
      archivedAt: null,
      ...(mine ? { currentAssigneeUserId: req.authUser.id } : {}),
    };

    const now = new Date();
    const todayKey = saudiDayKey(now);
    const todayNumber = dayNumberFromKey(todayKey);
    const todayStart = new Date(`${todayKey}T00:00:00+03:00`);
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);

    const rows = await prisma.transactionFollowUp.findMany({
      where: {
        ...baseWhere,
        OR: [
          { status: { in: OPEN_STATUSES } },
          { status: 'completed' },
          {
            status: 'closed',
            closedAt: { gte: todayStart, lt: tomorrowStart },
          },
        ],
      },
      include: {
        extensionRequests: {
          where: { status: 'pending' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        externalWaits: {
          where: { status: 'active' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: [
        { dueDate: { sort: 'asc', nulls: 'last' } },
        { priority: 'desc' },
        { updatedAt: 'desc' },
      ],
      take: 500,
    });

    const bucketOrder = [
      'overdue',
      'urgent_today',
      'extension_requests',
      'external_follow_up_due',
      'due_3_days',
      'awaiting_review',
      'waiting_external',
      'in_progress',
      'completed_today',
      'unassigned',
    ];
    const buckets = Object.fromEntries(bucketOrder.map((key) => [key, []]));
    const counts = Object.fromEntries(bucketOrder.map((key) => [key, 0]));

    for (const row of rows) {
      const bucket = classifyWorkQueueItem(row, todayNumber);
      if (!buckets[bucket]) continue;
      counts[bucket] += 1;
      if (buckets[bucket].length >= 80) continue;

      const serialized = serialize(row);
      const dueKey = row.dueDate ? saudiDayKey(new Date(row.dueDate)) : null;
      const dueNumber = dueKey ? dayNumberFromKey(dueKey) : null;
      const daysUntilDue = dueNumber == null ? null : dueNumber - todayNumber;
      const ageDays = Math.max(
        0,
        todayNumber - dayNumberFromKey(saudiDayKey(new Date(row.createdAt)))
      );

      const pendingExtension = row.extensionRequests?.[0] || null;
      const activeExternalWait = row.externalWaits?.[0] || null;
      const externalSentNumber = activeExternalWait
        ? dayNumberFromKey(saudiDayKey(new Date(activeExternalWait.sentAt)))
        : null;
      const externalFollowUpNumber = activeExternalWait
        ? dayNumberFromKey(saudiDayKey(new Date(activeExternalWait.nextFollowUpDate)))
        : null;
      const queueItem = {
        ...serialized,
        pendingExtension,
        activeExternalWait: activeExternalWait
          ? {
              ...activeExternalWait,
              waitingDays: Math.max(0, todayNumber - externalSentNumber),
              daysUntilFollowUp: externalFollowUpNumber - todayNumber,
              followUpDue: externalFollowUpNumber <= todayNumber,
            }
          : null,
        queueBucket: bucket,
        daysUntilDue,
        overdueDays: daysUntilDue != null && daysUntilDue < 0 ? Math.abs(daysUntilDue) : 0,
        ageDays,
        quickActions: workQueueActionOptions(row, supervisor, reopenAllowed),
      };
      buckets[bucket].push(queueItem);

      if (supervisor && pendingExtension) {
        counts.extension_requests += 1;
        if (buckets.extension_requests.length < 80) {
          buckets.extension_requests.push({
            ...queueItem,
            queueBucket: 'extension_requests',
          });
        }
      }

      if (activeExternalWait && externalFollowUpNumber <= todayNumber) {
        counts.external_follow_up_due += 1;
        if (buckets.external_follow_up_due.length < 80) {
          buckets.external_follow_up_due.push({
            ...queueItem,
            queueBucket: 'external_follow_up_due',
          });
        }
      }

      if (bucket !== 'waiting_external' && activeExternalWait) {
        counts.waiting_external += 1;
        if (buckets.waiting_external.length < 80) {
          buckets.waiting_external.push({
            ...queueItem,
            queueBucket: 'waiting_external',
          });
        }
      }
    }

    const priorityBuckets = [
      'overdue',
      'urgent_today',
      'extension_requests',
      'external_follow_up_due',
      'due_3_days',
      'awaiting_review',
      'waiting_external',
      'in_progress',
      'completed_today',
    ];
    const focusBucket = priorityBuckets.find((key) => counts[key] > 0) || 'in_progress';

    res.json({
      generatedAt: now,
      scope: mine ? 'mine' : 'all',
      supervisor,
      canReopen: reopenAllowed,
      focusBucket,
      counts,
      buckets,
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/work-queue-action', async (req, res, next) => {
  try {
    const input = workQueueQuickActionSchema.parse(req.body);
    const current = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (current.archivedAt) {
      return res.status(409).json({
        message: 'المعاملة مؤرشفة. استعدها من الأرشفة أولًا قبل تنفيذ أي إجراء عليها.',
      });
    }

    const reopening = input.action === 'reopen';
    if (reopening) {
      if (!canReopenRecord(req)) {
        return res.status(403).json({ message: 'لا تملك صلاحية إعادة فتح المعاملات المنجزة أو المغلقة' });
      }
      if (!['completed', 'closed'].includes(current.status)) {
        return res.status(409).json({ message: 'إعادة الفتح متاحة فقط للمعاملات المنجزة أو المغلقة' });
      }
      if (!input.note?.trim() || input.note.trim().length < 5) {
        return res.status(400).json({ message: 'سبب إعادة فتح المعاملة مطلوب ويجب توضيحه' });
      }
    } else if (!canActOnRecord(req, current)) {
      return denyRecordAccess(res);
    }

    const supervisor = isSupervisor(req);
    const supervisorOnly = ['approve_close', 'return_to_employee'];
    if (supervisorOnly.includes(input.action) && !supervisor) {
      return res.status(403).json({ message: 'مراجعة إنجاز المعاملة وإقفالها متاحة للمستخدم الإشرافي فقط' });
    }
    if (current.status === 'closed' && !reopening) {
      return res.status(409).json({ message: 'المعاملة مغلقة ولا تقبل إجراءً سريعًا جديدًا' });
    }
    if (input.action === 'waiting_external') {
      return res.status(409).json({
        message: 'استخدم نموذج «بانتظار جهة أخرى» لتسجيل الجهة والمرجع وتاريخ المتابعة القادمة',
      });
    }
    if (input.action === 'resume') {
      const activeExternalWait = await prisma.transactionFollowUpExternalWait.findFirst({
        where: { transactionId: current.id, status: 'active' },
        select: { id: true },
      });
      if (activeExternalWait) {
        return res.status(409).json({
          message: 'لا يمكن استئناف المعاملة قبل تسجيل ورود الرد أو إلغاء انتظار الجهة',
        });
      }
    }
    if (current.status === 'completed' && !supervisorOnly.includes(input.action) && !reopening) {
      return res.status(409).json({ message: 'المعاملة بانتظار المراجعة الإشرافية' });
    }

    const actionConfig = {
      start: {
        status: 'in_progress',
        eventType: 'work_started',
        text: 'بدء تنفيذ المعاملة',
      },
      waiting_external: {
        status: 'waiting_response',
        eventType: 'waiting_external',
        text: 'تحويل المعاملة إلى انتظار رد من جهة أخرى',
      },
      resume: {
        status: 'in_progress',
        eventType: 'work_resumed',
        text: 'استئناف العمل على المعاملة',
      },
      needs_follow_up: {
        status: 'needs_follow_up',
        eventType: 'follow_up_required',
        text: 'تحديد المعاملة كحالة تحتاج متابعة',
      },
      submit_completion: {
        status: 'completed',
        eventType: 'completion_submitted',
        text: 'رفع المعاملة للمراجعة بعد اكتمال التنفيذ',
      },
      approve_close: {
        status: 'closed',
        eventType: 'completion_approved',
        text: 'اعتماد إنجاز المعاملة وإقفالها',
      },
      return_to_employee: {
        status: 'in_progress',
        eventType: 'completion_returned',
        text: 'إعادة المعاملة للموظف لاستكمال المطلوب',
      },
      reopen: {
        status: current.currentAssigneeUserId ? 'in_progress' : 'new',
        eventType: 'transaction_reopened',
        text: 'إعادة فتح المعاملة بعد الإنجاز أو الإغلاق',
      },
    }[input.action];

    if (!actionConfig) return res.status(400).json({ message: 'الإجراء السريع غير مدعوم' });

    if (input.action === 'submit_completion' && !current.currentAssigneeUserId) {
      return res.status(409).json({ message: 'يجب إسناد المعاملة قبل رفعها كمكتملة' });
    }
    if (['approve_close', 'return_to_employee'].includes(input.action) && current.status !== 'completed') {
      return res.status(409).json({ message: 'هذا الإجراء متاح فقط للمعاملات المكتملة بانتظار المراجعة' });
    }

    if (['submit_completion', 'approve_close'].includes(input.action)) {
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

    const changedBy = actor(req);
    const changedAt = new Date();
    const completedAt =
      input.action === 'submit_completion'
        ? changedAt
        : ['return_to_employee', 'reopen'].includes(input.action)
          ? null
          : current.completedAt;
    const closedAt =
      input.action === 'approve_close'
        ? changedAt
        : input.action === 'reopen'
          ? null
          : current.closedAt;

    const updated = await prisma.transactionFollowUp.update({
      where: { id: current.id },
      data: {
        status: actionConfig.status,
        completedAt,
        closedAt,
        lastActionAt: changedAt,
        lastActionByUserId: changedBy.id,
        lastActionByName: changedBy.name,
        events: {
          create: {
            eventType: actionConfig.eventType,
            fromStatus: current.status,
            toStatus: actionConfig.status,
            fromAssigneeUserId: current.currentAssigneeUserId,
            fromAssigneeName: current.currentAssigneeName,
            toAssigneeUserId: current.currentAssigneeUserId,
            toAssigneeName: current.currentAssigneeName,
            actionText: actionConfig.text,
            note: input.note || null,
            createdById: changedBy.id,
            createdByName: changedBy.name,
          },
        },
      },
    });

    if (input.action === 'submit_completion') {
      const supervisorIds = await getFollowUpSupervisorIds();
      for (const userId of supervisorIds) {
        if (userId === changedBy.id) continue;
        await createFollowUpAlert({
          alertKey: `transaction:${current.id}:completion_submitted:${changedAt.toISOString()}:${userId}`,
          transactionId: current.id,
          userId,
          kind: 'transaction_completion_submitted',
          severity: 'info',
          title: 'معاملة مكتملة بانتظار المراجعة',
          message: `${current.transactionNumber} — ${current.subject}. رفعها ${changedBy.name} للمراجعة والإقفال.`,
        });
      }
    }

    if (['approve_close', 'return_to_employee'].includes(input.action) && current.currentAssigneeUserId) {
      await createFollowUpAlert({
        alertKey: `transaction:${current.id}:${input.action}:${changedAt.toISOString()}:${current.currentAssigneeUserId}`,
        transactionId: current.id,
        userId: current.currentAssigneeUserId,
        kind: input.action === 'approve_close'
          ? 'transaction_completion_approved'
          : 'transaction_completion_returned',
        severity: input.action === 'approve_close' ? 'info' : 'warning',
        title: input.action === 'approve_close'
          ? 'تم اعتماد إنجاز المعاملة'
          : 'أعيدت المعاملة لاستكمال المطلوب',
        message: input.action === 'approve_close'
          ? `${current.transactionNumber} — تم اعتماد الإنجاز وإقفال المعاملة.`
          : `${current.transactionNumber} — أعيدت المعاملة للاستكمال${input.note ? `: ${input.note}` : '.'}`,
      });
    }

    if (input.action === 'reopen' && current.currentAssigneeUserId && current.currentAssigneeUserId !== changedBy.id) {
      await createFollowUpAlert({
        alertKey: `transaction:${current.id}:reopened:${changedAt.toISOString()}:${current.currentAssigneeUserId}`,
        transactionId: current.id,
        userId: current.currentAssigneeUserId,
        kind: 'transaction_reopened',
        severity: 'warning',
        title: 'تمت إعادة فتح معاملة منجزة',
        message: `${current.transactionNumber} — أعاد ${changedBy.name} فتح المعاملة. السبب: ${input.note.trim()}`,
      });
    }

    res.json(serialize(updated));
  } catch (error) {
    next(error);
  }
});

router.get('/executive-inbox', async (req, res, next) => {
  try {
    const supervisor = isSupervisor(req);
    const mineRequested = String(req.query.mine || '').toLowerCase() === 'true';
    const mine = !supervisor || mineRequested;
    const baseWhere = {
      archivedAt: null,
      ...(mine ? { currentAssigneeUserId: req.authUser.id } : {}),
    };
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
    const supervisor = isSupervisor(req);
    const mineRequested = String(req.query.mine || '').toLowerCase() === 'true';
    const mine = !supervisor || mineRequested;
    const baseWhere = {
      archivedAt: null,
      ...(mine ? { currentAssigneeUserId: req.authUser.id } : {}),
    };
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

router.get('/reports/templates', async (req, res, next) => {
  try {
    const rows = await prisma.transactionFollowUpReportTemplate.findMany({
      where: {
        OR: [
          { createdById: req.authUser.id },
          { scope: 'shared' },
        ],
      },
      orderBy: [
        { isDefault: 'desc' },
        { sortOrder: 'asc' },
        { updatedAt: 'desc' },
      ],
    });

    const visibleRows = rows.filter((row) => canUseReportTemplate(req, row));
    res.json(visibleRows);
  } catch (error) {
    next(error);
  }
});

router.post('/reports/templates', async (req, res, next) => {
  try {
    const input = reportTemplateSchema.parse(req.body);
    const supervisor = isSupervisor(req);
    if (input.scope === 'shared' && !supervisor) {
      return res.status(403).json({
        message: 'إنشاء قالب عام للإدارة متاح للمستخدم الإشرافي فقط',
      });
    }

    const createdBy = actor(req);
    const requestedAssignee =
      input.scope === 'personal' && supervisor
        ? input.assigneeUserId || null
        : null;
    const assignee = requestedAssignee
      ? await resolveAssignee(requestedAssignee)
      : null;

    let customFrom = null;
    let customTo = null;
    if (input.reportMode === 'custom') {
      if (!input.customFrom || !input.customTo) {
        return res.status(400).json({
          message: 'الفترة المخصصة تتطلب تاريخ بداية ونهاية',
        });
      }
      customFrom = toDate(input.customFrom, 'بداية فترة القالب');
      customTo = toDate(input.customTo, 'نهاية فترة القالب');
      if (customFrom.getTime() > customTo.getTime()) {
        return res.status(400).json({
          message: 'بداية فترة القالب يجب أن تسبق نهايتها',
        });
      }
    }

    const accessMode = input.scope === 'shared' ? input.accessMode : 'all';
    const allowedUserIds =
      input.scope === 'shared' && accessMode === 'selected'
        ? await normalizeTemplateAllowedUserIds(input.allowedUserIds)
        : [];

    if (input.scope === 'shared' && accessMode === 'selected' && !allowedUserIds.length) {
      return res.status(400).json({
        message: 'حدد مستخدمًا واحدًا على الأقل للقالب العام المقيّد',
      });
    }

    const existing = await prisma.transactionFollowUpReportTemplate.findFirst({
      where: {
        createdById: createdBy.id,
        scope: input.scope,
        name: input.name,
      },
    });

    const sortOrder =
      input.sortOrder !== undefined
        ? input.sortOrder
        : existing?.sortOrder ?? await nextTemplateSortOrder(input.scope, createdBy.id);

    const data = {
      name: input.name,
      scope: input.scope,
      reportMode: input.reportMode,
      customFrom,
      customTo,
      assigneeUserId: assignee?.id || null,
      orientation: input.orientation,
      options: input.options,
      accessMode,
      allowedUserIds,
      isDefault: input.isDefault,
      sortOrder,
      createdByName: createdBy.name,
    };

    const row = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.transactionFollowUpReportTemplate.updateMany({
          where: input.scope === 'shared'
            ? { scope: 'shared', isDefault: true }
            : {
                scope: 'personal',
                createdById: createdBy.id,
                isDefault: true,
              },
          data: { isDefault: false },
        });
      }

      if (existing) {
        return tx.transactionFollowUpReportTemplate.update({
          where: { id: existing.id },
          data,
        });
      }

      return tx.transactionFollowUpReportTemplate.create({
        data: {
          ...data,
          createdById: createdBy.id,
        },
      });
    });

    res.status(existing ? 200 : 201).json(row);
  } catch (error) {
    next(error);
  }
});

router.patch('/reports/templates/:id', async (req, res, next) => {
  try {
    const input = reportTemplateSchema.partial().parse(req.body);
    const current = await prisma.transactionFollowUpReportTemplate.findUnique({
      where: { id: req.params.id },
    });
    if (!current) {
      return res.status(404).json({ message: 'قالب التقرير غير موجود' });
    }

    const supervisor = isSupervisor(req);
    const ownsTemplate = current.createdById === req.authUser.id;
    if (current.scope === 'shared') {
      if (!supervisor) {
        return res.status(403).json({
          message: 'تعديل القالب العام متاح للمستخدم الإشرافي فقط',
        });
      }
    } else if (!ownsTemplate) {
      return res.status(403).json({
        message: 'لا يمكنك تعديل قالب شخصي يخص مستخدمًا آخر',
      });
    }

    const nextScope = input.scope || current.scope;
    if (nextScope === 'shared' && !supervisor) {
      return res.status(403).json({
        message: 'تحويل القالب إلى قالب عام متاح للمستخدم الإشرافي فقط',
      });
    }

    const nextMode = input.reportMode || current.reportMode;
    let customFrom = current.customFrom;
    let customTo = current.customTo;
    if (nextMode === 'custom') {
      const fromValue = input.customFrom !== undefined
        ? input.customFrom
        : current.customFrom?.toISOString();
      const toValue = input.customTo !== undefined
        ? input.customTo
        : current.customTo?.toISOString();
      if (!fromValue || !toValue) {
        return res.status(400).json({
          message: 'الفترة المخصصة تتطلب تاريخ بداية ونهاية',
        });
      }
      customFrom = toDate(fromValue, 'بداية فترة القالب');
      customTo = toDate(toValue, 'نهاية فترة القالب');
      if (customFrom.getTime() > customTo.getTime()) {
        return res.status(400).json({
          message: 'بداية فترة القالب يجب أن تسبق نهايتها',
        });
      }
    } else {
      customFrom = null;
      customTo = null;
    }

    let assigneeUserId = current.assigneeUserId;
    if (nextScope === 'shared') {
      assigneeUserId = null;
    } else if (input.assigneeUserId !== undefined) {
      if (supervisor && input.assigneeUserId) {
        const assignee = await resolveAssignee(input.assigneeUserId);
        assigneeUserId = assignee.id;
      } else {
        assigneeUserId = null;
      }
    }

    if (input.name && input.name !== current.name) {
      const duplicate = await prisma.transactionFollowUpReportTemplate.findFirst({
        where: {
          createdById: current.createdById,
          scope: nextScope,
          name: input.name,
          NOT: { id: current.id },
        },
        select: { id: true },
      });
      if (duplicate) {
        return res.status(409).json({
          message: 'يوجد قالب آخر بالاسم نفسه',
        });
      }
    }

    const nextAccessMode =
      nextScope === 'shared'
        ? input.accessMode ?? current.accessMode ?? 'all'
        : 'all';
    const allowedUserIdsInput =
      input.allowedUserIds !== undefined
        ? input.allowedUserIds
        : templateAllowedUserIds(current);
    const nextAllowedUserIds =
      nextScope === 'shared' && nextAccessMode === 'selected'
        ? await normalizeTemplateAllowedUserIds(allowedUserIdsInput)
        : [];

    if (nextScope === 'shared' && nextAccessMode === 'selected' && !nextAllowedUserIds.length) {
      return res.status(400).json({
        message: 'حدد مستخدمًا واحدًا على الأقل للقالب العام المقيّد',
      });
    }

    const nextIsDefault = input.isDefault ?? current.isDefault;
    const nextSortOrder = input.sortOrder ?? current.sortOrder;

    const row = await prisma.$transaction(async (tx) => {
      if (nextIsDefault) {
        await tx.transactionFollowUpReportTemplate.updateMany({
          where: nextScope === 'shared'
            ? {
                scope: 'shared',
                isDefault: true,
                NOT: { id: current.id },
              }
            : {
                scope: 'personal',
                createdById: current.createdById,
                isDefault: true,
                NOT: { id: current.id },
              },
          data: { isDefault: false },
        });
      }

      return tx.transactionFollowUpReportTemplate.update({
        where: { id: current.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          scope: nextScope,
          reportMode: nextMode,
          customFrom,
          customTo,
          assigneeUserId,
          ...(input.orientation !== undefined ? { orientation: input.orientation } : {}),
          ...(input.options !== undefined ? { options: input.options } : {}),
          accessMode: nextAccessMode,
          allowedUserIds: nextAllowedUserIds,
          isDefault: nextIsDefault,
          sortOrder: nextSortOrder,
        },
      });
    });

    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.post('/reports/templates/reorder', async (req, res, next) => {
  try {
    const input = reportTemplateReorderSchema.parse(req.body);
    const supervisor = isSupervisor(req);

    if (input.scope === 'shared' && !supervisor) {
      return res.status(403).json({
        message: 'ترتيب القوالب العامة متاح للمستخدم الإشرافي فقط',
      });
    }

    const rows = await prisma.transactionFollowUpReportTemplate.findMany({
      where: input.scope === 'shared'
        ? { id: { in: input.orderedIds }, scope: 'shared' }
        : {
            id: { in: input.orderedIds },
            scope: 'personal',
            createdById: req.authUser.id,
          },
      select: { id: true },
    });

    if (rows.length !== input.orderedIds.length) {
      return res.status(400).json({
        message: 'قائمة ترتيب القوالب تحتوي على عناصر غير مسموح بها',
      });
    }

    await prisma.$transaction(
      input.orderedIds.map((id, index) =>
        prisma.transactionFollowUpReportTemplate.update({
          where: { id },
          data: { sortOrder: (index + 1) * 10 },
        }),
      ),
    );

    res.json({ updated: input.orderedIds.length });
  } catch (error) {
    next(error);
  }
});

router.post('/reports/templates/clone', async (req, res, next) => {
  try {
    const input = reportTemplateCloneSchema.parse(req.body);
    const source = await prisma.transactionFollowUpReportTemplate.findUnique({
      where: { id: input.templateId },
    });
    if (!source) {
      return res.status(404).json({ message: 'قالب التقرير غير موجود' });
    }
    if (!canUseReportTemplate(req, source)) {
      return res.status(403).json({ message: 'لا يمكنك استخدام هذا القالب' });
    }

    const baseName = input.name || `${source.name} - نسخة شخصية`;
    let nextName = baseName;
    let suffix = 2;
    while (
      await prisma.transactionFollowUpReportTemplate.findFirst({
        where: {
          createdById: req.authUser.id,
          scope: 'personal',
          name: nextName,
        },
        select: { id: true },
      })
    ) {
      nextName = `${baseName} (${suffix})`;
      suffix += 1;
    }

    const sortOrder = await nextTemplateSortOrder('personal', req.authUser.id);
    const createdBy = actor(req);
    const row = await prisma.transactionFollowUpReportTemplate.create({
      data: {
        name: nextName,
        scope: 'personal',
        reportMode: source.reportMode,
        customFrom: source.customFrom,
        customTo: source.customTo,
        assigneeUserId: null,
        orientation: source.orientation,
        options: source.options,
        accessMode: 'all',
        allowedUserIds: [],
        isDefault: false,
        sortOrder,
        createdById: req.authUser.id,
        createdByName: createdBy.name,
      },
    });

    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.delete('/reports/templates/:id', async (req, res, next) => {
  try {
    const current = await prisma.transactionFollowUpReportTemplate.findUnique({
      where: { id: req.params.id },
    });
    if (!current) {
      return res.status(404).json({ message: 'قالب التقرير غير موجود' });
    }

    if (current.scope === 'shared') {
      if (!isSupervisor(req)) {
        return res.status(403).json({
          message: 'حذف القالب العام متاح للمستخدم الإشرافي فقط',
        });
      }
    } else if (current.createdById !== req.authUser.id) {
      return res.status(403).json({
        message: 'لا يمكنك حذف قالب شخصي يخص مستخدمًا آخر',
      });
    }

    await prisma.transactionFollowUpReportTemplate.delete({
      where: { id: current.id },
    });
    res.status(204).end();
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
    const search = String(req.query.search || '').trim();
    const source = String(req.query.source || '').trim();
    const reportType = String(req.query.reportType || '').trim();
    const tag = String(req.query.tag || '').trim();
    const governanceStatus = String(req.query.governanceStatus || '').trim();
    const retentionPolicy = String(req.query.retentionPolicy || '').trim();
    const pinned = String(req.query.pinned || '').trim();
    const protectedFlag = String(req.query.protected || '').trim();

    const accessWhere = supervisor
      ? (requestedAssignee ? { assigneeUserId: requestedAssignee } : {})
      : { assigneeUserId: req.authUser.id };

    const where = {
      ...accessWhere,
      ...(source === 'manual' || source === 'scheduled' ? { source } : {}),
      ...(reportType === 'weekly' || reportType === 'monthly' || reportType === 'custom'
        ? { reportType }
        : {}),
      ...(tag ? { tags: { has: tag } } : {}),
      ...(governanceStatus === 'draft' || governanceStatus === 'final'
        ? { governanceStatus }
        : {}),
      ...(retentionPolicy && ['none', 'one_year', 'three_years', 'five_years', 'permanent', 'custom'].includes(retentionPolicy)
        ? { retentionPolicy }
        : {}),
      ...(pinned === 'true' ? { isPinned: true } : pinned === 'false' ? { isPinned: false } : {}),
      ...(protectedFlag === 'true'
        ? { isDeletionProtected: true }
        : protectedFlag === 'false'
          ? { isDeletionProtected: false }
          : {}),
      ...(search
        ? {
            OR: [
              { archiveName: { contains: search, mode: 'insensitive' } },
              { notes: { contains: search, mode: 'insensitive' } },
              { templateName: { contains: search, mode: 'insensitive' } },
              { assigneeName: { contains: search, mode: 'insensitive' } },
              { generatedByName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      prisma.transactionFollowUpReportArchive.count({ where }),
      prisma.transactionFollowUpReportArchive.findMany({
        where,
        select: {
          id: true,
          archiveName: true,
          notes: true,
          tags: true,
          governanceStatus: true,
          isPinned: true,
          isDeletionProtected: true,
          retentionPolicy: true,
          retainUntil: true,
          finalizedAt: true,
          finalizedById: true,
          finalizedByName: true,
          updatedById: true,
          updatedByName: true,
          reportType: true,
          periodFrom: true,
          periodTo: true,
          assigneeUserId: true,
          assigneeName: true,
          scopeMine: true,
          source: true,
          summary: true,
          scheduleId: true,
          templateId: true,
          templateName: true,
          templateSnapshot: true,
          generatedById: true,
          generatedByName: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
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

router.get('/reports/archives/:id/activity', async (req, res, next) => {
  try {
    const archive = await prisma.transactionFollowUpReportArchive.findUnique({
      where: { id: req.params.id },
    });
    if (!archive) {
      return res.status(404).json({ message: 'التقرير المؤرشف غير موجود' });
    }
    if (!isSupervisor(req) && archive.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'لا يمكنك عرض سجل هذا التقرير' });
    }

    const rows = await prisma.auditLog.findMany({
      where: {
        module: 'transaction_follow_up',
        entity: 'report_archive',
        entityId: archive.id,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        action: true,
        description: true,
        details: true,
        username: true,
        userEmail: true,
        userRole: true,
        createdAt: true,
      },
    });

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/reports/archives/:id/export-event', async (req, res, next) => {
  try {
    const input = reportArchiveExportEventSchema.parse(req.body);
    const archive = await prisma.transactionFollowUpReportArchive.findUnique({
      where: { id: req.params.id },
    });
    if (!archive) {
      return res.status(404).json({ message: 'التقرير المؤرشف غير موجود' });
    }
    if (!isSupervisor(req) && archive.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'لا يمكنك تصدير هذا التقرير' });
    }

    const formatLabels = {
      pdf: 'PDF',
      excel: 'Excel',
      print: 'طباعة',
    };

    await auditReportArchiveAction(req, {
      action: 'report_archive_export',
      archive,
      description: `تصدير التقرير المؤرشف بصيغة ${formatLabels[input.format]}`,
      details: {
        format: input.format,
        fileName: input.fileName || null,
      },
    });

    res.json({ recorded: true });
  } catch (error) {
    next(error);
  }
});

router.patch('/reports/archives/:id/governance', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'حوكمة أرشيف التقارير متاحة للمستخدم الإشرافي فقط' });
    }

    const input = reportArchiveGovernanceSchema.parse(req.body);
    const current = await prisma.transactionFollowUpReportArchive.findUnique({
      where: { id: req.params.id },
    });
    if (!current) {
      return res.status(404).json({ message: 'التقرير المؤرشف غير موجود' });
    }

    const nextPolicy = input.retentionPolicy ?? current.retentionPolicy;
    let retainUntil = current.retainUntil;
    if (input.retentionPolicy !== undefined || input.retainUntil !== undefined) {
      if (nextPolicy === 'custom') {
        const raw = input.retainUntil !== undefined
          ? input.retainUntil
          : current.retainUntil?.toISOString();
        if (!raw) {
          return res.status(400).json({ message: 'سياسة الاحتفاظ المخصصة تتطلب تاريخ انتهاء' });
        }
        retainUntil = toDate(raw, 'تاريخ انتهاء الاحتفاظ');
        if (retainUntil.getTime() <= Date.now()) {
          return res.status(400).json({ message: 'تاريخ انتهاء الاحتفاظ يجب أن يكون في المستقبل' });
        }
      } else {
        retainUntil = null;
      }
    }

    const nextStatus = input.governanceStatus ?? current.governanceStatus;
    const statusChanged = nextStatus !== current.governanceStatus;
    const supervisorActor = actor(req);

    const row = await prisma.transactionFollowUpReportArchive.update({
      where: { id: current.id },
      data: {
        ...(input.governanceStatus !== undefined ? { governanceStatus: input.governanceStatus } : {}),
        ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
        ...(input.isDeletionProtected !== undefined
          ? { isDeletionProtected: input.isDeletionProtected }
          : {}),
        ...(input.retentionPolicy !== undefined ? { retentionPolicy: input.retentionPolicy } : {}),
        ...(input.retentionPolicy !== undefined || input.retainUntil !== undefined
          ? { retainUntil }
          : {}),
        ...(statusChanged && nextStatus === 'final'
          ? {
              finalizedAt: new Date(),
              finalizedById: supervisorActor.id,
              finalizedByName: supervisorActor.name,
            }
          : statusChanged && nextStatus === 'draft'
            ? {
                finalizedAt: null,
                finalizedById: null,
                finalizedByName: null,
              }
            : {}),
        updatedById: supervisorActor.id,
        updatedByName: supervisorActor.name,
      },
    });

    await auditReportArchiveAction(req, {
      action: 'report_archive_governance_update',
      archive: row,
      description: 'تحديث إعدادات حوكمة التقرير المؤرشف',
      previousData: {
        governanceStatus: current.governanceStatus,
        isPinned: current.isPinned,
        isDeletionProtected: current.isDeletionProtected,
        retentionPolicy: current.retentionPolicy,
        retainUntil: current.retainUntil ? current.retainUntil.toISOString() : null,
      },
      newData: {
        governanceStatus: row.governanceStatus,
        isPinned: row.isPinned,
        isDeletionProtected: row.isDeletionProtected,
        retentionPolicy: row.retentionPolicy,
        retainUntil: row.retainUntil ? row.retainUntil.toISOString() : null,
      },
    });

    res.json(row);
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

    const manualSnapshot = input.templateSnapshot
      ? manualReportArchiveSnapshotSchema.parse(input.templateSnapshot)
      : null;

    const archive = await archiveTransactionExecutiveReport({
      archiveName: input.archiveName || manualSnapshot?.name || null,
      notes: input.notes || null,
      tags: input.tags || [],
      reportType: input.reportType,
      from,
      to,
      assigneeUserId: assignee?.id || null,
      assigneeName: assignee?.username || null,
      scopeMine: !supervisor || Boolean(assignee),
      source: 'manual',
      templateId: null,
      templateName: null,
      templateSnapshot: manualSnapshot,
      generatedById: createdBy.id,
      generatedByName: createdBy.name,
    });

    await auditReportArchiveAction(req, {
      action: 'report_archive_create',
      archive,
      description: 'إنشاء نسخة مؤرشفة من التقرير',
      newData: {
        archiveName: archive.archiveName,
        reportType: archive.reportType,
        source: archive.source,
        governanceStatus: archive.governanceStatus,
      },
    });

    res.status(201).json(archive);
  } catch (error) {
    next(error);
  }
});

router.patch('/reports/archives/:id', async (req, res, next) => {
  try {
    const input = reportArchiveMetadataSchema.parse(req.body);
    const current = await prisma.transactionFollowUpReportArchive.findUnique({
      where: { id: req.params.id },
    });
    if (!current) {
      return res.status(404).json({ message: 'التقرير المؤرشف غير موجود' });
    }

    const supervisor = isSupervisor(req);
    if (!supervisor && current.assigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'لا يمكنك تعديل بيانات هذا التقرير المؤرشف' });
    }
    if (!supervisor && current.governanceStatus === 'final') {
      return res.status(403).json({ message: 'التقرير النهائي لا يمكن تعديل بياناته إلا من المستخدم الإشرافي' });
    }

    const updater = actor(req);
    const row = await prisma.transactionFollowUpReportArchive.update({
      where: { id: current.id },
      data: {
        archiveName: input.archiveName || null,
        notes: input.notes || null,
        tags: input.tags || [],
        updatedById: updater.id,
        updatedByName: updater.name,
      },
    });

    await auditReportArchiveAction(req, {
      action: 'report_archive_metadata_update',
      archive: row,
      description: 'تعديل بيانات التقرير المؤرشف',
      previousData: {
        archiveName: current.archiveName,
        notes: current.notes,
        tags: current.tags,
      },
      newData: {
        archiveName: row.archiveName,
        notes: row.notes,
        tags: row.tags,
      },
    });

    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.delete('/reports/archives/:id', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'حذف التقارير المؤرشفة متاح للمستخدم الإشرافي فقط' });
    }

    const current = await prisma.transactionFollowUpReportArchive.findUnique({
      where: { id: req.params.id },
    });
    if (!current) {
      return res.status(404).json({ message: 'التقرير المؤرشف غير موجود' });
    }

    const blockReason = archiveDeletionBlockReason(current);
    if (blockReason) {
      return res.status(409).json({ message: blockReason });
    }

    await auditReportArchiveAction(req, {
      action: 'report_archive_delete',
      archive: current,
      description: 'حذف تقرير مؤرشف',
      previousData: {
        archiveName: current.archiveName,
        reportType: current.reportType,
        governanceStatus: current.governanceStatus,
        retentionPolicy: current.retentionPolicy,
      },
    });

    await prisma.transactionFollowUpReportArchive.delete({ where: { id: current.id } });
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
    const template = await resolveScheduleTemplate(req, input.templateId || null);
    const templateSnapshot = reportTemplateScheduleSnapshot(template);
    const templateAssigneeId =
      template?.scope === 'personal' ? template.assigneeUserId || null : null;
    const requestedAssignee = supervisor
      ? input.assigneeUserId || templateAssigneeId || null
      : req.authUser.id;
    const assignee = requestedAssignee ? await resolveAssignee(requestedAssignee) : null;
    const createdBy = actor(req);

    const draft = {
      frequency: input.frequency,
      dayOfWeek: input.frequency === 'weekly' ? (input.dayOfWeek ?? 0) : null,
      dayOfMonth: input.frequency === 'monthly' ? (input.dayOfMonth ?? 1) : null,
      runHour: input.runHour,
    };

    const templateOrganizationalUnit =
      template?.options && typeof template.options === 'object'
        ? template.options.organizationalUnit || null
        : null;

    const row = await prisma.transactionFollowUpReportSchedule.create({
      data: {
        name: input.name,
        frequency: input.frequency,
        dayOfWeek: draft.dayOfWeek,
        dayOfMonth: draft.dayOfMonth,
        runHour: input.runHour,
        organizationalUnit: templateOrganizationalUnit || null,
        assigneeUserId: assignee?.id || null,
        assigneeName: assignee?.username || null,
        templateId: template?.id || null,
        templateName: template?.name || null,
        templateSnapshot,
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

    const nextTemplateId =
      input.templateId !== undefined
        ? input.templateId || null
        : current.templateId || null;
    const template = nextTemplateId
      ? await resolveScheduleTemplate(req, nextTemplateId)
      : null;
    const templateSnapshot = template
      ? reportTemplateScheduleSnapshot(template)
      : input.templateId === null
        ? null
        : current.templateSnapshot;
    const templateAssigneeId =
      template?.scope === 'personal' ? template.assigneeUserId || null : null;

    const nextFrequency = input.frequency || current.frequency;
    const requestedAssignee = supervisor
      ? (
          input.assigneeUserId !== undefined
            ? input.assigneeUserId || null
            : templateAssigneeId || current.assigneeUserId
        )
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

    const templateOrganizationalUnit =
      template?.options && typeof template.options === 'object'
        ? template.options.organizationalUnit || null
        : current.organizationalUnit;

    const row = await prisma.transactionFollowUpReportSchedule.update({
      where: { id: current.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        frequency: nextFrequency,
        dayOfWeek: nextSchedule.dayOfWeek,
        dayOfMonth: nextSchedule.dayOfMonth,
        runHour: nextSchedule.runHour,
        organizationalUnit: templateOrganizationalUnit || null,
        assigneeUserId: assignee?.id || null,
        assigneeName: assignee?.username || null,
        templateId: template?.id || null,
        templateName: template?.name || null,
        templateSnapshot,
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

router.get('/reports/backup-schedule', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'إعداد النسخ الاحتياطي الآلي متاح للمستخدم الإشرافي فقط' });
    }
    const [schedule, runs] = await Promise.all([
      getOrCreateTransactionBackupSchedule(),
      prisma.transactionFollowUpBackupRun.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    res.json({ schedule, runs });
  } catch (error) {
    next(error);
  }
});

router.put('/reports/backup-schedule', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'إعداد النسخ الاحتياطي الآلي متاح للمستخدم الإشرافي فقط' });
    }
    const input = backupScheduleSchema.parse(req.body);
    const changedBy = actor(req);
    const schedule = await updateTransactionBackupSchedule({
      frequency: input.frequency,
      dayOfWeek: input.frequency === 'weekly' ? (input.dayOfWeek ?? 0) : null,
      dayOfMonth: input.frequency === 'monthly' ? (input.dayOfMonth ?? 1) : null,
      runHour: input.runHour,
      includeAttachments: input.includeAttachments,
      retentionCount: input.retentionCount,
      isActive: input.isActive,
      updatedById: changedBy.id,
      updatedByName: changedBy.name,
    });
    res.json(schedule);
  } catch (error) {
    next(error);
  }
});

router.post('/reports/backup-schedule/run', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'تشغيل النسخة الاحتياطية متاح للمستخدم الإشرافي فقط' });
    }
    const changedBy = actor(req);
    const schedule = await getOrCreateTransactionBackupSchedule();
    const result = await runTransactionFollowUpBackup({
      schedule,
      triggeredById: changedBy.id,
      triggeredByName: changedBy.name,
    });
    if (result.skipped) {
      return res.status(409).json({ message: 'توجد نسخة احتياطية قيد التنفيذ بالفعل', run: result.run });
    }
    res.status(result.run?.status === 'failed' ? 500 : 201).json({
      run: result.run,
      failedAttachments: result.copyFailures || [],
      message:
        result.run?.status === 'partial'
          ? 'تم إنشاء النسخة الاحتياطية مع وجود بعض المرفقات التي تعذر نسخها'
          : result.run?.status === 'success'
            ? 'تم إنشاء النسخة الاحتياطية بنجاح'
            : 'تعذر إنشاء النسخة الاحتياطية',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/reports/backup-runs/:id/verify', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'فحص سلامة النسخ الاحتياطية متاح للمستخدم الإشرافي فقط' });
    }
    const run = await verifyTransactionBackupRun(req.params.id);
    res.json(run);
  } catch (error) {
    next(error);
  }
});

router.post('/reports/backup-runs/:id/restore-test', async (req, res, next) => {
  try {
    if (!isSupervisor(req)) {
      return res.status(403).json({ message: 'اختبار استعادة النسخ الاحتياطية متاح للمستخدم الإشرافي فقط' });
    }
    const run = await testTransactionBackupRestore(req.params.id);
    res.json(run);
  } catch (error) {
    next(error);
  }
});

router.get('/reports/backup-data', async (req, res, next) => {
  try {
    if (!hasFollowUpPermission(req, 'canPrint')) {
      return res.status(403).json({ message: 'لا تملك صلاحية تصدير تقارير أو نسخ احتياطية' });
    }

    const full = String(req.query.full || '').toLowerCase() === 'true';
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const from = full
      ? null
      : (req.query.from ? toDate(String(req.query.from), 'بداية فترة التقرير') : defaultFrom);
    const toRaw = full
      ? null
      : (req.query.to ? toDate(String(req.query.to), 'نهاية فترة التقرير') : defaultTo);
    const to = toRaw ? new Date(toRaw) : null;
    if (to) to.setHours(23, 59, 59, 999);

    if (from && to && from.getTime() > to.getTime()) {
      return res.status(400).json({ message: 'بداية فترة التقرير يجب أن تسبق نهايتها' });
    }

    const requestedAssignee = String(req.query.assigneeUserId || '').trim();
    const mine = String(req.query.mine || '').toLowerCase() === 'true';
    const supervisor = isSupervisor(req);
    const scopeAssigneeId = supervisor
      ? (mine ? req.authUser.id : requestedAssignee || null)
      : req.authUser.id;

    const assigneeScope = scopeAssigneeId ? { currentAssigneeUserId: scopeAssigneeId } : {};
    const periodScope = full
      ? {}
      : {
          OR: [
            { transactionDate: { gte: from, lte: to } },
            { completedAt: { gte: from, lte: to } },
            { closedAt: { gte: from, lte: to } },
            { archivedAt: { gte: from, lte: to } },
          ],
        };

    const transactions = await prisma.transactionFollowUp.findMany({
      where: {
        ...assigneeScope,
        ...periodScope,
      },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        directives: {
          include: {
            reviews: { orderBy: { reviewedAt: 'asc' } },
          },
          orderBy: { issuedAt: 'asc' },
        },
        extensionRequests: { orderBy: { createdAt: 'asc' } },
        externalWaits: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
    });

    const transactionIds = transactions.map((item) => item.id);
    const directiveIds = transactions.flatMap((item) => item.directives.map((directive) => directive.id));

    const attachments = transactionIds.length || directiveIds.length
      ? await prisma.attachment.findMany({
          where: {
            OR: [
              ...(transactionIds.length
                ? [{ entityType: 'transaction_follow_up', entityId: { in: transactionIds } }]
                : []),
              ...(directiveIds.length
                ? [{ entityType: 'transaction_follow_up_directive', entityId: { in: directiveIds } }]
                : []),
            ],
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    res.json({
      generatedAt: now,
      full,
      period: full ? null : { from, to },
      scope: {
        mine: !supervisor || mine,
        assigneeUserId: scopeAssigneeId,
      },
      transactions,
      attachments,
      totals: {
        transactions: transactions.length,
        events: transactions.reduce((sum, item) => sum + item.events.length, 0),
        directives: transactions.reduce((sum, item) => sum + item.directives.length, 0),
        attachments: attachments.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/reports/backup-attachments/:attachmentId', async (req, res, next) => {
  try {
    if (!hasFollowUpPermission(req, 'canPrint')) {
      return res.status(403).json({ message: 'لا تملك صلاحية تنزيل مرفقات النسخة الاحتياطية' });
    }

    const attachment = await prisma.attachment.findUnique({
      where: { id: req.params.attachmentId },
    });
    if (!attachment || !['transaction_follow_up', 'transaction_follow_up_directive'].includes(attachment.entityType)) {
      return res.status(404).json({ message: 'المرفق غير موجود' });
    }

    let transaction = null;
    if (attachment.entityType === 'transaction_follow_up') {
      transaction = await prisma.transactionFollowUp.findUnique({
        where: { id: attachment.entityId },
        select: { id: true, currentAssigneeUserId: true },
      });
    } else {
      const directive = await prisma.transactionFollowUpDirective.findUnique({
        where: { id: attachment.entityId },
        include: {
          transaction: {
            select: { id: true, currentAssigneeUserId: true },
          },
        },
      });
      transaction = directive?.transaction || null;
    }

    if (!transaction) {
      return res.status(404).json({ message: 'تعذر تحديد المعاملة المرتبطة بالمرفق' });
    }
    if (!isSupervisor(req) && transaction.currentAssigneeUserId !== req.authUser.id) {
      return res.status(403).json({ message: 'المرفق خارج نطاق معاملاتك' });
    }
    if (!attachment.driveFileId) {
      return res.status(409).json({ message: 'لا تتوفر نسخة قابلة للتنزيل لهذا المرفق' });
    }

    const downloaded = await downloadGoogleDriveFile(attachment.driveFileId);
    const downloadName = String(attachment.title || downloaded.fileName || 'attachment')
      .replace(/[\r\n"]/g, '_');

    res.setHeader('Content-Type', downloaded.mimeType || attachment.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(downloaded.buffer);
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
    const supervisor = isSupervisor(req);
    const mineRequested = String(req.query.mine || '').toLowerCase() === 'true';
    const mine = !supervisor || mineRequested;
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

router.get('/archived', async (req, res, next) => {
  try {
    if (!canViewTransactionArchive(req)) {
      return res.status(403).json({ message: 'لا تملك صلاحية الاطلاع على المعاملات المؤرشفة' });
    }

    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(req.query.pageSize || '30'), 10) || 30));
    const search = String(req.query.search || '').trim();

    const where = {
      archivedAt: { not: null },
      ...(search
        ? {
            OR: [
              { trackingNumber: { contains: search, mode: 'insensitive' } },
              { transactionNumber: { contains: search, mode: 'insensitive' } },
              { subject: { contains: search, mode: 'insensitive' } },
              { sourceEntity: { contains: search, mode: 'insensitive' } },
              { currentAssigneeName: { contains: search, mode: 'insensitive' } },
              { archivedByName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.transactionFollowUp.count({ where }),
      prisma.transactionFollowUp.findMany({
        where,
        orderBy: [{ archivedAt: 'desc' }, { updatedAt: 'desc' }],
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

router.get('/archived/:id', async (req, res, next) => {
  try {
    if (!canViewTransactionArchive(req)) {
      return res.status(403).json({ message: 'لا تملك صلاحية الاطلاع على المعاملات المؤرشفة' });
    }

    const row = await prisma.transactionFollowUp.findFirst({
      where: { id: req.params.id, archivedAt: { not: null } },
      include: {
        events: { orderBy: { createdAt: 'desc' } },
        directives: {
          include: { reviews: { orderBy: { reviewedAt: 'desc' } } },
          orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        },
        extensionRequests: { orderBy: { createdAt: 'desc' } },
        externalWaits: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!row) return res.status(404).json({ message: 'المعاملة المؤرشفة غير موجودة' });

    const attachments = await prisma.attachment.findMany({
      where: {
        entityType: 'transaction_follow_up',
        entityId: row.id,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ ...serialize(row), attachments });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/archive', async (req, res, next) => {
  try {
    if (!canArchiveTransaction(req)) {
      return res.status(403).json({ message: 'لا تملك صلاحية ترحيل المعاملات إلى الأرشفة' });
    }

    const input = archiveActionSchema.parse(req.body || {});
    const current = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (current.archivedAt) {
      return res.status(409).json({ message: 'المعاملة مؤرشفة مسبقًا' });
    }
    if (current.status !== 'closed') {
      return res.status(409).json({
        message: 'لا يمكن ترحيل المعاملة إلى الأرشفة إلا بعد اعتماد إنجازها وإقفالها.',
      });
    }

    const changedBy = actor(req);
    const archivedAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUp.update({
        where: { id: current.id },
        data: {
          archivedAt,
          archivedById: changedBy.id,
          archivedByName: changedBy.name,
          archiveNote: input.note || null,
        },
      });

      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: current.id,
          eventType: 'archived',
          fromStatus: current.status,
          toStatus: current.status,
          fromAssigneeUserId: current.currentAssigneeUserId,
          fromAssigneeName: current.currentAssigneeName,
          toAssigneeUserId: current.currentAssigneeUserId,
          toAssigneeName: current.currentAssigneeName,
          actionText: 'ترحيل المعاملة إلى الأرشفة',
          note: input.note || null,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });

      return row;
    });

    res.json(serialize(updated));
  } catch (error) {
    next(error);
  }
});

router.patch('/archived/:id/restore', async (req, res, next) => {
  try {
    if (!canRestoreTransactionArchive(req)) {
      return res.status(403).json({ message: 'لا تملك صلاحية استعادة المعاملات من الأرشفة' });
    }

    const input = archiveActionSchema.parse(req.body || {});
    const current = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (!current.archivedAt) {
      return res.status(409).json({ message: 'المعاملة غير موجودة في الأرشفة' });
    }

    const changedBy = actor(req);
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.transactionFollowUp.update({
        where: { id: current.id },
        data: {
          archivedAt: null,
          archivedById: null,
          archivedByName: null,
          archiveNote: null,
        },
      });

      await tx.transactionFollowUpEvent.create({
        data: {
          transactionId: current.id,
          eventType: 'archive_restored',
          fromStatus: current.status,
          toStatus: current.status,
          fromAssigneeUserId: current.currentAssigneeUserId,
          fromAssigneeName: current.currentAssigneeName,
          toAssigneeUserId: current.currentAssigneeUserId,
          toAssigneeName: current.currentAssigneeName,
          actionText: 'استعادة المعاملة من الأرشفة',
          note: input.note || null,
          createdById: changedBy.id,
          createdByName: changedBy.name,
        },
      });

      return row;
    });

    res.json(serialize(updated));
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
    const organizationalUnit = String(req.query.organizationalUnit || '').trim();
    const assigneeUserId = String(req.query.assigneeUserId || '').trim();
    const supervisor = isSupervisor(req);
    const mineRequested = String(req.query.mine || '').toLowerCase() === 'true';
    const mine = !supervisor || mineRequested;

    const where = {
      archivedAt: null,
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
      ...(['endowments_properties', 'mosques_prayer_rooms'].includes(organizationalUnit)
        ? { organizationalUnit }
        : {}),
      ...(mine
        ? { currentAssigneeUserId: req.authUser.id }
        : supervisor && assigneeUserId
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

router.post('/:id/attachments', async (req, res, next) => {
  try {
    const input = transactionAttachmentSchema.parse(req.body);
    const transaction = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
    });
    if (!transaction) return res.status(404).json({ message: 'المعاملة غير موجودة' });

    const supervisor = isSupervisor(req);
    const assignedUploader =
      hasFollowUpPermission(req, 'canUploadAttachments') &&
      transaction.currentAssigneeUserId === req.authUser?.id;
    const creatorUploader =
      hasFollowUpPermission(req, 'canUploadAttachments') &&
      hasFollowUpPermission(req, 'canAdd') &&
      transaction.createdById === req.authUser?.id;

    if (!(supervisor || assignedUploader || creatorUploader)) {
      return res.status(403).json({
        message: 'لا تملك صلاحية رفع مرفقات لهذه المعاملة، أو أن المعاملة غير مسندة إليك',
      });
    }
    if (!supervisor && FINAL_STATUSES.includes(transaction.status)) {
      return res.status(409).json({ message: 'لا يمكن إضافة مرفقات إلى معاملة منجزة أو مغلقة' });
    }

    const changedBy = actor(req);
    const attachment = await prisma.attachment.create({
      data: {
        entityType: 'transaction_follow_up',
        entityId: transaction.id,
        attachmentType: 'other',
        title: input.title,
        driveUrl: input.driveUrl,
        driveFileId: input.driveFileId || null,
        mimeType: input.mimeType || null,
        notes: input.notes || null,
        createdBy: changedBy.name,
        createdById: changedBy.id,
      },
    });

    await prisma.transactionFollowUpEvent.create({
      data: {
        transactionId: transaction.id,
        eventType: 'attachment_added',
        fromAssigneeUserId: transaction.currentAssigneeUserId,
        fromAssigneeName: transaction.currentAssigneeName,
        toAssigneeUserId: transaction.currentAssigneeUserId,
        toAssigneeName: transaction.currentAssigneeName,
        actionText: 'إضافة مرفق للمعاملة',
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

router.delete('/:id/attachments/:attachmentId', async (req, res, next) => {
  try {
    const transaction = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
    });
    if (!transaction) return res.status(404).json({ message: 'المعاملة غير موجودة' });

    const supervisor = isSupervisor(req);

    const attachment = await prisma.attachment.findFirst({
      where: {
        id: req.params.attachmentId,
        entityType: 'transaction_follow_up',
        entityId: transaction.id,
      },
    });
    if (!attachment) return res.status(404).json({ message: 'المرفق غير موجود' });

    const canDeleteOwnAttachment =
      hasFollowUpPermission(req, 'canDeleteAttachments') &&
      transaction.currentAssigneeUserId === req.authUser?.id &&
      attachment.createdById === req.authUser?.id;

    if (!(supervisor || canDeleteOwnAttachment)) {
      return res.status(403).json({
        message: 'يمكنك حذف المرفقات التي رفعتها بنفسك فقط، ما لم تكن مستخدمًا إشرافيًا',
      });
    }
    if (!supervisor && FINAL_STATUSES.includes(transaction.status)) {
      return res.status(409).json({ message: 'لا يمكن حذف مرفقات معاملة منجزة أو مغلقة' });
    }

    if (attachment.driveFileId) {
      try {
        await deleteGoogleDriveFile(attachment.driveFileId);
      } catch (error) {
        console.warn('Unable to delete transaction attachment from Google Drive:', error?.message || error);
      }
    }

    await prisma.attachment.delete({ where: { id: attachment.id } });

    const changedBy = actor(req);
    await prisma.transactionFollowUpEvent.create({
      data: {
        transactionId: transaction.id,
        eventType: 'attachment_removed',
        fromAssigneeUserId: transaction.currentAssigneeUserId,
        fromAssigneeName: transaction.currentAssigneeName,
        toAssigneeUserId: transaction.currentAssigneeUserId,
        toAssigneeName: transaction.currentAssigneeName,
        actionText: 'حذف مرفق من المعاملة',
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
        extensionRequests: {
          orderBy: { createdAt: 'desc' },
        },
        externalWaits: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!row) return res.status(404).json({ message: 'المعاملة غير موجودة' });
    if (!canViewRecord(req, row)) {
      return res.status(403).json({ message: 'لا تملك صلاحية عرض هذه المعاملة، أو أنها ليست ضمن نطاق عملك' });
    }

    const attachments = await prisma.attachment.findMany({
      where: {
        entityType: 'transaction_follow_up',
        entityId: row.id,
      },
      orderBy: { createdAt: 'desc' },
    });

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
      attachments,
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
    if (!hasFollowUpPermission(req, 'canAdd')) {
      return res.status(403).json({
        message: 'لا تملك صلاحية إضافة معاملة جديدة في نظام المتابعة.',
      });
    }

    const input = createSchema.parse(req.body);
    const user = await resolveAssignee(input.currentAssigneeUserId);
    const createdBy = actor(req);
    const transactionNumber = normalizeTransactionNumber(input.transactionNumber);
    const transactionDateMeta = parseTransactionDate(input.transactionDate, input.transactionDateType);
    await assertUniqueTransactionNumberYear({
      transactionNumber,
      transactionYear: transactionDateMeta.transactionYear,
    });
    const dueDate = toDate(input.dueDate, 'تاريخ الاستحقاق');
    const now = new Date();

    let trackingNumber = await nextTrackingNumber();
    let row;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        row = await prisma.transactionFollowUp.create({
          data: {
            trackingNumber,
            transactionNumber,
            transactionDate: transactionDateMeta.transactionDate,
            transactionDateType: transactionDateMeta.transactionDateType,
            transactionDateInput: transactionDateMeta.transactionDateInput,
            transactionYear: transactionDateMeta.transactionYear,
            transactionType: input.transactionType,
            organizationalUnit: input.organizationalUnit,
            subject: input.subject,
            sourceEntity: input.sourceEntity || null,
            priority: input.priority,
            status: user ? 'in_progress' : 'new',
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
                  toStatus: user ? 'in_progress' : 'new',
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
        if (isTransactionNumberYearConstraint(error)) {
          throw duplicateTransactionError(transactionNumber, transactionDateMeta.transactionYear);
        }
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

    if (
      input.transactionDateType !== undefined &&
      input.transactionDateType !== (current.transactionDateType || 'gregorian') &&
      input.transactionDate === undefined
    ) {
      const error = new Error('حدد تاريخ المعاملة بعد تغيير نوع التاريخ إلى هجري أو ميلادي');
      error.status = 400;
      throw error;
    }

    const shouldRefreshDateIdentity =
      input.transactionNumber !== undefined ||
      input.transactionDate !== undefined ||
      input.transactionDateType !== undefined ||
      !Number.isInteger(current.transactionYear);

    const transactionNumber = normalizeTransactionNumber(
      input.transactionNumber !== undefined ? input.transactionNumber : current.transactionNumber,
    );
    const dateType =
      input.transactionDateType !== undefined
        ? input.transactionDateType
        : (current.transactionDateType || 'gregorian');
    const dateInput =
      input.transactionDate !== undefined
        ? input.transactionDate
        : (current.transactionDateInput || current.transactionDate.toISOString().slice(0, 10));
    const transactionDateMeta = shouldRefreshDateIdentity
      ? parseTransactionDate(dateInput, dateType)
      : null;

    if (transactionDateMeta) {
      await assertUniqueTransactionNumberYear({
        transactionNumber,
        transactionYear: transactionDateMeta.transactionYear,
        excludeId: current.id,
      });
    }

    let updated;
    try {
      updated = await prisma.transactionFollowUp.update({
        where: { id: current.id },
        data: {
          ...(input.transactionNumber !== undefined ? { transactionNumber } : {}),
          ...(transactionDateMeta
            ? {
                transactionDate: transactionDateMeta.transactionDate,
                transactionDateType: transactionDateMeta.transactionDateType,
                transactionDateInput: transactionDateMeta.transactionDateInput,
                transactionYear: transactionDateMeta.transactionYear,
              }
            : {}),
          ...(input.transactionType !== undefined ? { transactionType: input.transactionType } : {}),
          ...(input.organizationalUnit !== undefined ? { organizationalUnit: input.organizationalUnit } : {}),
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
    } catch (error) {
      if (isTransactionNumberYearConstraint(error)) {
        const year = transactionDateMeta?.transactionYear || effectiveTransactionYear(current);
        throw duplicateTransactionError(transactionNumber, year);
      }
      throw error;
    }

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

    const supervisor = isSupervisor(req);
    const initialAssignment = !current.currentAssigneeUserId;
    const creatorCanAssign =
      initialAssignment &&
      hasFollowUpPermission(req, 'canAdd') &&
      current.createdById === req.authUser?.id;

    if (initialAssignment) {
      if (!(supervisor || creatorCanAssign)) {
        return res.status(403).json({
          message: 'إسناد المعاملة غير المسندة متاح للمستخدم الإشرافي أو لمن أنشأ المعاملة ولديه صلاحية «إضافة».',
        });
      }
    } else {
      if (!canTransferRecord(req)) {
        return res.status(403).json({ message: 'لا تملك صلاحية تحويل المعاملات في نظام المتابعة' });
      }
      if (!supervisor) {
        if (current.currentAssigneeUserId !== req.authUser?.id) {
          return res.status(403).json({
            message: 'يمكنك تحويل المعاملات المسندة إليك فقط.',
          });
        }
        if (!input.note?.trim() || input.note.trim().length < 3) {
          return res.status(400).json({
            message: 'سبب تحويل المعاملة مطلوب للمستخدم العادي.',
          });
        }
      }
    }

    if (FINAL_STATUSES.includes(current.status)) {
      return res.status(409).json({ message: 'المعاملة منجزة أو مغلقة. أعد فتحها قبل إعادة الإسناد.' });
    }

    const target = await resolveAssignee(input.assigneeUserId);
    if (target.id === current.currentAssigneeUserId) {
      return res.status(409).json({ message: 'المعاملة مسندة بالفعل إلى الموظف المحدد' });
    }

    const changedBy = actor(req);
    const now = new Date();
    const eventType = current.currentAssigneeUserId ? 'transferred' : 'assigned';
    const nextStatus = current.status === 'waiting_response' ? 'waiting_response' : 'in_progress';

    const updated = await prisma.transactionFollowUp.update({
      where: { id: current.id },
      data: {
        currentAssigneeUserId: target.id,
        currentAssigneeName: target.username,
        assignedAt: now,
        status: nextStatus,
        lastActionAt: now,
        lastActionByUserId: changedBy.id,
        lastActionByName: changedBy.name,
        events: {
          create: {
            eventType,
            fromStatus: current.status,
            toStatus: nextStatus,
            fromAssigneeUserId: current.currentAssigneeUserId,
            fromAssigneeName: current.currentAssigneeName,
            toAssigneeUserId: target.id,
            toAssigneeName: target.username,
            actionText: eventType === 'transferred'
              ? 'تحويل المعاملة إلى موظف آخر وبدء معالجتها'
              : 'إسناد المعاملة وبدء معالجتها',
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
      message: `${updated.transactionNumber} — ${updated.subject}. بدأت المعالجة تلقائيًا عند التحويل. المطلوب: ${updated.requiredAction || 'مراجعة المعاملة واتخاذ الإجراء المناسب'}.`,
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

    if (nextStatus === 'closed' && !isSupervisor(req)) {
      return res.status(403).json({
        message: 'إقفال المعاملة بعد الإنجاز يتطلب مراجعة واعتماد مستخدم إشرافي',
      });
    }
    if (current.status === 'completed' && nextStatus !== 'completed' && !isSupervisor(req)) {
      return res.status(409).json({
        message: 'المعاملة مكتملة وبانتظار المراجعة الإشرافية ولا يمكن تعديل حالتها من الموظف',
      });
    }

    if (current.status === 'waiting_response' && nextStatus !== 'waiting_response') {
      const activeExternalWait = await prisma.transactionFollowUpExternalWait.findFirst({
        where: { transactionId: current.id, status: 'active' },
        select: { id: true },
      });
      if (activeExternalWait) {
        return res.status(409).json({
          message: 'المعاملة مرتبطة بانتظار جهة نشط؛ سجّل ورود الرد أو ألغِ الانتظار قبل تغيير الحالة',
        });
      }
    }

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

    if (nextStatus === 'completed' && current.status !== 'completed') {
      const supervisorIds = await getFollowUpSupervisorIds();
      for (const userId of supervisorIds) {
        if (userId === changedBy.id) continue;
        await createFollowUpAlert({
          alertKey: `transaction:${current.id}:completion_submitted:${now.toISOString()}:${userId}`,
          transactionId: current.id,
          userId,
          kind: 'transaction_completion_submitted',
          severity: 'info',
          title: 'معاملة مكتملة بانتظار المراجعة',
          message: `${current.transactionNumber} — ${current.subject}. تم رفعها للمراجعة والإقفال.`,
        });
      }
    }

    res.json(serialize(updated));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!canDeleteRecord(req)) return denyRecordAccess(res, 'delete');

    const current = await prisma.transactionFollowUp.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        transactionNumber: true,
        subject: true,
      },
    });
    if (!current) return res.status(404).json({ message: 'المعاملة غير موجودة' });

    await prisma.transactionFollowUp.delete({ where: { id: current.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
