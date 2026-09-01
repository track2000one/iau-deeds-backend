import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { uploadBufferToGoogleDrive } from '../services/googleDrive.js';
import { hashPassword } from '../security/auth.js';
import { sendMosquePersonnelActivationEmail } from '../services/email.service.js';

const router = Router();
export const mosquesPublicRoutes = Router();

const REQUEST_TRANSITIONS = {
  new: ['under_review', 'returned_for_edit', 'rejected'],
  under_review: ['approved', 'returned_for_edit', 'rejected'],
  returned_for_edit: ['new'],
  approved: ['in_progress'],
  in_progress: ['completed'],
  completed: ['closed', 'in_progress'],
  closed: [],
  rejected: [],
};

const TICKET_TRANSITIONS = {
  new: ['under_review', 'assigned', 'rejected'],
  under_review: ['assigned', 'in_progress', 'rejected'],
  assigned: ['in_progress', 'rejected'],
  in_progress: ['resolved'],
  resolved: ['closed', 'in_progress'],
  closed: [],
  rejected: [],
};

const LEAVE_TRANSITIONS = {
  pending: ['under_review', 'approved', 'returned_for_edit', 'rejected'],
  under_review: ['approved', 'returned_for_edit', 'rejected'],
  returned_for_edit: ['pending'],
  approved: [],
  rejected: [],
};

const JOB_TRANSITIONS = {
  new: ['under_review', 'rejected'],
  under_review: ['shortlisted', 'rejected'],
  shortlisted: ['interview', 'rejected'],
  interview: ['accepted', 'rejected'],
  accepted: ['archived'],
  rejected: ['archived'],
  archived: [],
};

const requestStatusLabels = {
  new: 'جديد',
  under_review: 'تحت المراجعة',
  approved: 'معتمد',
  returned_for_edit: 'معاد للتعديل',
  rejected: 'مرفوض',
  in_progress: 'قيد التنفيذ',
  completed: 'مكتمل',
  closed: 'مغلق',
};

const randomDigits = (length = 5) => {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
};

const trackingNumber = (prefix) => `${prefix}-${new Date().getFullYear()}-${randomDigits(5)}`;

const nullableText = (value) => {
  const normalized = String(value ?? '').trim();
  return normalized || null;
};

const MOSQUE_ACTIVATION_TOKEN_HOURS = Math.max(1, Number(process.env.ACCOUNT_ACTIVATION_TOKEN_HOURS || 24));
const MOSQUE_FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
const hashMosqueActivationToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const createMosqueActivationData = () => {
  const plainToken = crypto.randomBytes(48).toString('hex');
  return {
    plainToken,
    tokenHash: hashMosqueActivationToken(plainToken),
    expiresAt: new Date(Date.now() + MOSQUE_ACTIVATION_TOKEN_HOURS * 60 * 60 * 1000),
  };
};
const buildMosqueActivationUrl = (plainToken) => `${MOSQUE_FRONTEND_URL}/#/activate-account?token=${encodeURIComponent(plainToken)}`;
const normalizeMosqueRole = (role) => role === 'viewer' ? 'university_member' : role;
const MOSQUE_PERSONNEL_ROLE_LABELS = { imam: 'إمام', muezzin: 'مؤذن', khateeb: 'خطيب', collaborating_khateeb: 'خطيب متعاون', collaborator: 'خطيب متعاون' };
const MOSQUE_MODULE_ROLE_LABELS = { head: 'رئيس الوحدة', supervisor: 'مشرف الوحدة', personnel: 'منسوب المسجد أو المصلى', university_member: 'منسوب الجامعة', viewer: 'منسوب الجامعة' };


// مصدر أسماء الإمام والمؤذن والخطيب في بطاقة المسجد هو سجل منسوبي المساجد نفسه.
// لا نعتمد على الحقول النصية اليدوية داخل MosqueSite حتى لا تتقادم الأسماء عند النقل أو التعديل.
const enrichMosqueSitePersonnelNames = async (sites) => {
  const inputWasArray = Array.isArray(sites);
  const list = inputWasArray ? sites : (sites ? [sites] : []);
  if (!list.length) return inputWasArray ? [] : null;

  const siteIds = [...new Set(list.map((site) => site?.id).filter(Boolean))];
  const personnelRows = siteIds.length
    ? await prisma.mosquePersonnel.findMany({
        where: {
          siteId: { in: siteIds },
          active: true,
          role: { in: ['imam', 'muezzin', 'khateeb'] },
        },
        select: { siteId: true, name: true, role: true },
        orderBy: [{ siteId: 'asc' }, { role: 'asc' }, { name: 'asc' }],
      })
    : [];

  const grouped = new Map();
  for (const row of personnelRows) {
    if (!grouped.has(row.siteId)) grouped.set(row.siteId, { imam: [], muezzin: [], khateeb: [] });
    const bucket = grouped.get(row.siteId);
    if (bucket?.[row.role] && row.name?.trim()) bucket[row.role].push(row.name.trim());
  }

  const linked = list.map((site) => {
    const roles = grouped.get(site.id) || { imam: [], muezzin: [], khateeb: [] };
    return {
      ...site,
      imamName: roles.imam.length ? roles.imam.join('، ') : null,
      muezzinName: roles.muezzin.length ? roles.muezzin.join('، ') : null,
      khateebName: roles.khateeb.length ? roles.khateeb.join('، ') : null,
    };
  });

  return inputWasArray ? linked : linked[0];
};

const enrichMosqueApplicants = async (items, userField) => {
  const userIds = [...new Set(items.map((item) => item?.[userField]).filter(Boolean))];
  if (!userIds.length) return items.map((item) => ({ ...item, applicant: null }));

  const [personnelRows, userRows, assignmentRows] = await Promise.all([
    prisma.mosquePersonnel.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, name: true, role: true, mobile: true, email: true, active: true },
    }),
    prisma.appUser.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, email: true, role: true },
    }),
    prisma.mosqueUserAssignment.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, role: true, personnelRole: true },
    }),
  ]);

  const personnelByUser = new Map(personnelRows.filter((row) => row.userId).map((row) => [row.userId, row]));
  const userById = new Map(userRows.map((row) => [row.id, row]));
  const assignmentByUser = new Map(assignmentRows.map((row) => [row.userId, row]));

  return items.map((item) => {
    const userId = item?.[userField];
    if (!userId) return { ...item, applicant: null };
    const personnel = personnelByUser.get(userId);
    const user = userById.get(userId);
    const assignment = assignmentByUser.get(userId);
    const moduleRole = user?.role === 'admin' ? 'head' : normalizeMosqueRole(assignment?.role || 'university_member');
    const personnelRole = personnel?.role || assignment?.personnelRole || null;
    const roleLabel = personnelRole
      ? (MOSQUE_PERSONNEL_ROLE_LABELS[personnelRole] || personnelRole)
      : user?.role === 'admin'
        ? 'مسؤول النظام'
        : (MOSQUE_MODULE_ROLE_LABELS[moduleRole] || 'مستخدم');

    return {
      ...item,
      applicant: {
        userId,
        name: personnel?.name || user?.username || 'مستخدم',
        email: personnel?.email || user?.email || null,
        mobile: personnel?.mobile || null,
        role: personnelRole,
        roleLabel,
        moduleRole,
        active: personnel?.active ?? true,
      },
    };
  });
};

const hasFullMosquePermission = (user) => {
  const permission = user?.permissions?.find((item) => item.module === 'mosques');
  return Boolean(
    permission?.canView &&
    permission?.canAdd &&
    permission?.canEdit &&
    permission?.canDelete &&
    permission?.canPrint
  );
};

const getModuleRole = async (req) => {
  if (req.authUser?.role === 'admin') {
    return { role: 'head', siteId: null, assignment: null, fullPermissionAccess: true, accessSource: 'system_admin' };
  }

  const assignment = await prisma.mosqueUserAssignment.findUnique({ where: { userId: req.authUser.id } });

  // صلاحيات الوحدة الكاملة تمنح نطاق إدارة شامل داخل وحدة المساجد،
  // مع إبقاء المنصب التشغيلي الرسمي منفصلًا عن الصلاحية.
  if (hasFullMosquePermission(req.authUser)) {
    return {
      role: 'head',
      siteId: null,
      assignment,
      fullPermissionAccess: true,
      accessSource: 'module_permissions',
    };
  }

  return assignment
    ? { role: normalizeMosqueRole(assignment.role), siteId: assignment.siteId || null, assignment, fullPermissionAccess: false, accessSource: 'assignment' }
    : { role: 'university_member', siteId: null, assignment: null, fullPermissionAccess: false, accessSource: 'default' };
};

const getManagedSiteIds = async (req, context = null) => {
  const ctx = context || await getModuleRole(req);
  if (ctx.role === 'head') return null;
  if (ctx.role === 'supervisor') {
    const rows = await prisma.mosqueSite.findMany({
      where: { supervisorUserId: req.authUser.id },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
  if (ctx.role === 'personnel' && ctx.siteId) return [ctx.siteId];
  return [];
};

const assertSupervisorSiteAccess = async (req, siteId, context = null) => {
  const ctx = context || req.mosqueRole || await getModuleRole(req);
  if (ctx.role === 'head') return ctx;
  if (ctx.role !== 'supervisor') {
    const error = new Error('لا تملك صلاحية إدارة هذا المسجد أو المصلى');
    error.statusCode = 403;
    throw error;
  }
  const site = await prisma.mosqueSite.findFirst({
    where: { id: siteId, supervisorUserId: req.authUser.id },
    select: { id: true },
  });
  if (!site) {
    const error = new Error('هذا الموقع غير مسند إلى حساب المشرف الحالي');
    error.statusCode = 403;
    throw error;
  }
  return ctx;
};

const assertQuranInventorySiteAccess = async (req, siteId, context = null) => {
  const ctx = context || req.mosqueRole || await getModuleRole(req);
  if (ctx.role === 'head') return ctx;
  if (ctx.role === 'supervisor') {
    await assertSupervisorSiteAccess(req, siteId, ctx);
    return ctx;
  }
  if (ctx.role === 'personnel' && ctx.siteId === siteId) return ctx;
  const error = new Error('لا تملك صلاحية إدارة جرد المصاحف لهذا الموقع');
  error.statusCode = 403;
  throw error;
};

const requireRoles = (...roles) => async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    req.mosqueRole = context;
    if (!roles.includes(context.role)) {
      return res.status(403).json({ message: 'الدور التشغيلي داخل وحدة المساجد لا يسمح بهذه العملية' });
    }
    next();
  } catch (error) {
    next(error);
  }
};

const ensureTransition = (map, current, next) => {
  if (current === next) return;
  const allowed = map[current] || [];
  if (!allowed.includes(next)) {
    const error = new Error(`لا يمكن تغيير الحالة من ${current} إلى ${next}`);
    error.statusCode = 400;
    throw error;
  }
};

const requireDecisionReason = (status, input) => {
  if (status === 'rejected' && !nullableText(input.rejectionReason || input.note)) {
    const error = new Error('سبب الرفض إلزامي');
    error.statusCode = 400;
    throw error;
  }
  if (status === 'returned_for_edit' && !nullableText(input.returnReason || input.note)) {
    const error = new Error('ملاحظة الإعادة للتعديل إلزامية');
    error.statusCode = 400;
    throw error;
  }
};

const notify = async ({ userId = null, roleTarget = null, siteId = null, title, message, entityType = null, entityId = null }) => {
  try {
    await prisma.mosqueNotification.create({
      data: { userId, roleTarget, siteId, title, message, entityType, entityId },
    });
  } catch (error) {
    console.warn('Unable to create mosque notification:', error?.message || error);
  }
};

const siteSchema = z.object({
  name: z.string().trim().min(2),
  siteType: z.enum(['mosque', 'jami', 'prayer_room']).default('mosque'),
  prayerRoomGender: z.enum(['men', 'women']).optional().nullable(),
  city: z.string().trim().optional().nullable(),
  district: z.string().trim().optional().nullable(),
  campusLocation: z.string().trim().optional().nullable(),
  area: z.coerce.number().nonnegative().optional().nullable(),
  capacity: z.coerce.number().int().nonnegative().optional().nullable(),
  quranTargetCount: z.coerce.number().int().min(0).max(1000000).optional().nullable(),
  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  mapUrl: z.string().trim().optional().nullable(),
  status: z.enum(['active', 'maintenance', 'temporarily_closed']).default('active'),
  imamName: z.string().trim().optional().nullable(),
  muezzinName: z.string().trim().optional().nullable(),
  khateebName: z.string().trim().optional().nullable(),
  contactPhone: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  images: z.union([
    z.array(z.string()),
    z.object({
      photos: z.array(z.object({
        url: z.string().url(),
        fileId: z.string().optional().nullable(),
        fileName: z.string().optional().nullable(),
        mimeType: z.string().optional().nullable(),
        category: z.enum(['site_image', 'mosque_image']).optional().default('mosque_image'),
      })).optional().default([]),
      documents: z.array(z.object({
        url: z.string().url(),
        fileId: z.string().optional().nullable(),
        fileName: z.string().optional().nullable(),
        mimeType: z.string().optional().nullable(),
      })).optional().default([]),
    }),
  ]).optional().default({ photos: [], documents: [] }),
  supervisorUserId: z.string().trim().optional().nullable(),
});

const fieldVisitImageSchema = z.object({
  url: z.string().url(),
  fileId: z.string().trim().optional().nullable(),
  fileName: z.string().trim().optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  mimeType: z.string().trim().optional().nullable(),
  fileSize: z.number().nonnegative().optional().nullable(),
  capturedAt: z.string().trim().optional().nullable(),
});

const fieldVisitItemSchema = z.object({
  id: z.string().optional(),
  category: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  status: z.enum(['good', 'needs_action', 'not_available', 'not_applicable', 'not_checked']).default('not_checked'),
  note: z.string().trim().max(5000).optional().nullable(),
  priority: z.enum(['low', 'normal', 'medium', 'high', 'urgent']).default('normal'),
  responsibleEntity: z.string().trim().max(300).optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
  resolutionStatus: z.enum(['new', 'referred', 'in_progress', 'resolved', 'closed']).default('new'),
  resolutionNote: z.string().trim().max(5000).optional().nullable(),
  beforeImages: z.array(fieldVisitImageSchema).optional().default([]),
  afterImages: z.array(fieldVisitImageSchema).optional().default([]),
});

const fieldTourSchema = z.object({
  title: z.string().trim().min(2).max(300),
  scheduledDate: z.coerce.date(),
  scope: z.string().trim().max(1000).optional().nullable(),
  teamMembers: z.array(z.string().trim().min(1).max(200)).min(1),
  status: z.enum(['scheduled', 'in_progress', 'completed', 'postponed', 'cancelled']).optional().default('scheduled'),
  notes: z.string().trim().max(5000).optional().nullable(),
  siteIds: z.array(z.string().min(1)).min(1),
});

const fieldVisitSchema = z.object({
  tourId: z.string().optional().nullable(),
  siteId: z.string().min(1),
  visitType: z.enum(['initial', 'follow_up', 'urgent', 'closure_verification']).default('initial'),
  visitDate: z.coerce.date(),
  departureAt: z.coerce.date().optional().nullable(),
  representativeName: z.string().trim().max(300).optional().nullable(),
  teamMembers: z.array(z.string().trim().min(1).max(200)).min(1),
  overallStatus: z.enum(['excellent', 'good', 'needs_attention', 'critical']).default('good'),
  priority: z.enum(['low', 'normal', 'medium', 'high', 'urgent']).default('normal'),
  workflowStatus: z.enum(['planned', 'in_progress', 'completed', 'follow_up', 'closed']).default('completed'),
  generalNotes: z.string().trim().max(10000).optional().nullable(),
  recommendations: z.string().trim().max(10000).optional().nullable(),
  attachments: z.array(fieldVisitImageSchema).max(100).optional().default([]),
  items: z.array(fieldVisitItemSchema).default([]),
});

const FIELD_VISIT_CHECKLIST = [
  ['النظافة', 'نظافة السجاد والأرضيات'],
  ['النظافة', 'نظافة الجدران والنوافذ وخلو الموقع من الروائح'],
  ['النظافة', 'نظافة مرافق الوضوء ودورات المياه'],
  ['التكييف والتهوية', 'كفاءة التكييف والتهوية وعدم وجود تسربات'],
  ['الإنارة والكهرباء', 'سلامة الإنارة والمفاتيح والمقابس'],
  ['الإنارة والكهرباء', 'عدم وجود تمديدات كهربائية مكشوفة أو غير آمنة'],
  ['الصوتيات', 'سلامة الميكروفونات والسماعات وأجهزة الأذان'],
  ['السلامة', 'وضوح مخارج الطوارئ وخلوها من العوائق'],
  ['السلامة', 'توفر طفايات الحريق وصلاحيتها'],
  ['السلامة', 'سلامة الأبواب والممرات وسهولة الحركة'],
  ['التجهيزات', 'توفر دواليب ورفوف المصاحف بحالة مناسبة'],
  ['التجهيزات', 'سلامة الفواصل والستائر والساعات واللوحات'],
  ['المصاحف', 'سلامة المصاحف والتحقق من جهة الطباعة'],
  ['المصاحف', 'كفاية أعداد المصاحف وملاءمة أحجامها'],
  ['الكتب والمطبوعات', 'خلو الموقع من الكتب والنشرات غير المعتمدة'],
  ['الأنشطة', 'اعتماد حلقات التحفيظ والمحاضرات والأنشطة القائمة'],
  ['سهولة الوصول', 'ملاءمة الموقع لكبار السن والأشخاص ذوي الإعاقة'],
  ['المظهر العام', 'تنظيم الموقع ووضوح اتجاه القبلة وجاهزيته للصلاة'],
].map(([category, title]) => ({ category, title }));

const fieldVisitItemData = (item) => ({
  category: item.category,
  title: item.title,
  status: item.status,
  note: item.note || null,
  priority: item.priority,
  responsibleEntity: item.responsibleEntity || null,
  dueDate: item.dueDate || null,
  resolutionStatus: item.resolutionStatus,
  resolutionNote: item.resolutionNote || null,
  beforeImages: item.beforeImages || [],
  afterImages: item.afterImages || [],
});

const requestSchema = z.object({
  siteId: z.string().min(1),
  requestType: z.enum(['maintenance', 'renovation', 'equipment', 'cleaning', 'carpet', 'air_conditioning', 'audio', 'lighting', 'other']),
  description: z.string().trim().min(5),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  attachments: z.array(z.string()).optional().default([]),
  notes: z.string().trim().optional().nullable(),
});

const leaveSchema = z.object({
  siteId: z.string().min(1),
  personnelId: z.string().optional().nullable(),
  requestType: z.enum(['leave', 'apology', 'temporary_absence']),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  reason: z.string().trim().min(3),
  replacementName: z.string().trim().min(2),
  replacementUserId: z.string().trim().optional().nullable(),
  attachmentUrl: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});


const quranInventorySchema = z.object({
  siteId: z.string().min(1),
  largeCount: z.coerce.number().int().min(0).max(100000).default(0),
  mediumCount: z.coerce.number().int().min(0).max(100000).default(0),
  smallCount: z.coerce.number().int().min(0).max(100000).default(0),
  damagedCount: z.coerce.number().int().min(0).max(100000).default(0),
  neededCount: z.coerce.number().int().min(0).max(100000).default(0),
  countedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const quranOpeningBaselineSchema = z.object({
  siteId: z.string().min(1),
  largeCount: z.coerce.number().int().min(0).max(1000000).default(0),
  mediumCount: z.coerce.number().int().min(0).max(1000000).default(0),
  smallCount: z.coerce.number().int().min(0).max(1000000).default(0),
  recommendedWithdrawalCount: z.coerce.number().int().min(0).max(1000000).default(0),
  countedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const QURAN_OPENING_BASELINE_SITE_ACTION = 'quran_opening_baseline_site';
const QURAN_OPENING_BASELINE_CLOSED_ACTION = 'quran_opening_baseline_closed';

const quranWarehouseSchema = z.object({
  code: z.string().trim().min(2).max(40).optional().nullable(),
  name: z.string().trim().min(2).max(180),
  location: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional().default(true),
  minLargeCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  minMediumCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  minSmallCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const quranStockMovementSchema = z.object({
  movementType: z.enum(['receipt', 'distribution', 'return', 'site_withdrawal', 'warehouse_damage', 'adjustment_in', 'adjustment_out']),
  warehouseId: z.string().min(1),
  siteId: z.string().min(1).optional().nullable(),
  largeCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  mediumCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  smallCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  referenceNumber: z.string().trim().max(120).optional().nullable(),
  movementAt: z.coerce.date().optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});


const assignmentSchema = z.object({
  role: z.enum(['head', 'supervisor', 'personnel', 'university_member', 'viewer']),
  siteId: z.string().optional().nullable(),
  personnelRole: z.enum(['imam', 'muezzin', 'khateeb', 'collaborating_khateeb', 'collaborator']).optional().nullable(),
});


const personnelAccountSchema = z.object({
  siteId: z.string().min(1),
  name: z.string().trim().min(2),
  role: z.enum(['imam', 'muezzin', 'khateeb', 'collaborating_khateeb']),
  mobile: z.string().trim().optional().nullable(),
  email: z.string().email(),
});

const publicUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    cb(allowed.includes(file.mimetype) ? null : new Error('نوع الملف غير مسموح'), allowed.includes(file.mimetype));
  },
});

const PUBLIC_MOSQUE_GALLERY_SOURCES = [
  'https://ibb.co/P2V3164',
  'https://ibb.co/tM3nbwH6',
  'https://ibb.co/ymtDtp20',
  'https://ibb.co/DDTKhqCt',
  'https://ibb.co/zh7Nf4Qq',
  'https://ibb.co/LhQ02hFt',
  'https://ibb.co/vxw8GYH7',
  'https://ibb.co/PGBD1NfH',
  'https://ibb.co/d4dCHm5T',
  'https://ibb.co/0pBK0QK3',
  'https://ibb.co/fdXZ1y1d',
  'https://ibb.co/Zprjs45M',
  'https://ibb.co/3mx1wmsp',
  'https://ibb.co/9mfpW44C',
  'https://ibb.co/xtyJLMdh',
];

let publicMosqueGalleryCache = { expiresAt: 0, items: [] };

const normalizeGalleryImageUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const driveFile = raw.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i)?.[1];
  const driveQuery = raw.match(/[?&]id=([^&#]+)/i)?.[1];
  const driveId = driveFile || driveQuery;
  return driveId ? `https://drive.google.com/uc?export=view&id=${encodeURIComponent(driveId)}` : raw;
};

const decodeHtmlUrl = (value) => String(value || '')
  .replace(/&amp;/g, '&')
  .replace(/&#x2F;/gi, '/')
  .replace(/&#47;/g, '/')
  .trim();

const extractOpenGraphImage = (html) => {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1]) return decodeHtmlUrl(match[1]);
  }
  return '';
};

const resolveImgBbGallerySource = async (pageUrl, index) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(pageUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; IAU-Mosques-Gallery/1.0)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const imageUrl = extractOpenGraphImage(html);
    if (!/^https?:\/\//i.test(imageUrl)) return null;
    return {
      id: `external-${index + 1}`,
      title: 'مساجد ومصليات جامعة الإمام عبدالرحمن بن فيصل',
      imageUrl,
      sourcePage: pageUrl,
      source: 'external',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const resolvePublicMosqueExternalGallery = async () => {
  if (publicMosqueGalleryCache.expiresAt > Date.now() && publicMosqueGalleryCache.items.length) {
    return publicMosqueGalleryCache.items;
  }
  const resolved = await Promise.all(PUBLIC_MOSQUE_GALLERY_SOURCES.map(resolveImgBbGallerySource));
  const items = resolved.filter(Boolean);
  publicMosqueGalleryCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, items };
  return items;
};

mosquesPublicRoutes.get('/sites', async (_req, res, next) => {
  try {
    const sites = await prisma.mosqueSite.findMany({
      where: { status: { not: 'temporarily_closed' } },
      select: {
        publicToken: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true,
        campusLocation: true, area: true, capacity: true, latitude: true, longitude: true, mapUrl: true, status: true,
      },
      orderBy: { name: 'asc' },
    });
    res.json(sites);
  } catch (error) { next(error); }
});

mosquesPublicRoutes.get('/sites/:token', async (req, res, next) => {
  try {
    const site = await prisma.mosqueSite.findUnique({
      where: { publicToken: req.params.token },
      select: {
        publicToken: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true,
        campusLocation: true, area: true, capacity: true, latitude: true, longitude: true, mapUrl: true, status: true,
      },
    });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });
    res.json(site);
  } catch (error) { next(error); }
});

mosquesPublicRoutes.get('/gallery', async (_req, res, next) => {
  try {
    const [sites, externalItems] = await Promise.all([
      prisma.mosqueSite.findMany({
        where: { status: { not: 'temporarily_closed' } },
        select: { id: true, name: true, images: true },
        orderBy: { name: 'asc' },
      }),
      resolvePublicMosqueExternalGallery(),
    ]);

    const siteItems = sites.flatMap((site) => {
      const legacyPhotos = Array.isArray(site.images) ? site.images : [];
      const structuredPhotos = !Array.isArray(site.images) && site.images && Array.isArray(site.images.photos)
        ? site.images.photos
        : [];
      const photos = [
        ...legacyPhotos.map((url) => ({ url })),
        ...structuredPhotos,
      ];
      return photos.map((photo, index) => ({
        id: `site-${site.id}-${index + 1}`,
        title: site.name,
        imageUrl: normalizeGalleryImageUrl(photo?.url || ''),
        sourcePage: null,
        source: 'site',
      })).filter((item) => /^https?:\/\//i.test(item.imageUrl));
    });

    const seen = new Set();
    const items = [...siteItems, ...externalItems].filter((item) => {
      const key = String(item.imageUrl || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400');
    res.json(items);
  } catch (error) {
    next(error);
  }
});

mosquesPublicRoutes.post('/tickets', publicUpload.single('file'), async (req, res, next) => {
  try {
    const site = req.body.siteToken
      ? await prisma.mosqueSite.findUnique({ where: { publicToken: String(req.body.siteToken) } })
      : req.body.siteId
        ? await prisma.mosqueSite.findUnique({ where: { id: String(req.body.siteId) } })
        : null;
    if (!site) return res.status(400).json({ message: 'اختر المسجد أو المصلى' });

    const description = String(req.body.description || '').trim();
    if (description.length < 5) return res.status(400).json({ message: 'وصف البلاغ يجب ألا يقل عن 5 أحرف' });

    let attachmentUrl = null;
    if (req.file) {
      const uploaded = await uploadBufferToGoogleDrive(req.file, { fileName: `mosque-ticket-${Date.now()}-${req.file.originalname}` });
      attachmentUrl = uploaded.driveUrl;
    }

    const ticket = await prisma.mosqueTicket.create({
      data: {
        ticketNumber: trackingNumber('TKT'),
        siteId: site.id,
        ticketType: nullableText(req.body.ticketType) || 'general',
        description,
        reporterName: nullableText(req.body.reporterName),
        reporterPhone: nullableText(req.body.reporterPhone),
        reporterEmail: nullableText(req.body.reporterEmail),
        attachmentUrl,
        status: 'new',
      },
    });
    await notify({ roleTarget: 'supervisor', siteId: site.id, title: 'بلاغ جديد', message: `تم استلام البلاغ ${ticket.ticketNumber} في ${site.name}`, entityType: 'ticket', entityId: ticket.id });
    res.status(201).json({ ticketNumber: ticket.ticketNumber, trackingToken: ticket.trackingToken, status: ticket.status });
  } catch (error) { next(error); }
});

mosquesPublicRoutes.get('/tickets/track/:token', async (req, res, next) => {
  try {
    const ticket = await prisma.mosqueTicket.findUnique({
      where: { trackingToken: req.params.token },
      select: { ticketNumber: true, status: true, createdAt: true, updatedAt: true, resolutionNote: true, site: { select: { name: true } } },
    });
    if (!ticket) return res.status(404).json({ message: 'رمز متابعة البلاغ غير صحيح' });
    res.json(ticket);
  } catch (error) { next(error); }
});

mosquesPublicRoutes.post('/jobs', publicUpload.fields([{ name: 'cv', maxCount: 1 }, { name: 'certificate', maxCount: 1 }]), async (req, res, next) => {
  try {
    const required = ['fullName', 'nationalId', 'phone', 'email', 'qualification', 'jobType'];
    for (const field of required) {
      if (!nullableText(req.body[field])) return res.status(400).json({ message: `الحقل ${field} مطلوب` });
    }

    const cvFile = req.files?.cv?.[0];
    const certificateFile = req.files?.certificate?.[0];
    let cvUrl = null;
    let certificateUrl = null;
    if (cvFile) cvUrl = (await uploadBufferToGoogleDrive(cvFile, { fileName: `mosque-job-cv-${Date.now()}-${cvFile.originalname}` })).driveUrl;
    if (certificateFile) certificateUrl = (await uploadBufferToGoogleDrive(certificateFile, { fileName: `mosque-job-cert-${Date.now()}-${certificateFile.originalname}` })).driveUrl;

    const application = await prisma.mosqueJobApplication.create({
      data: {
        applicationNumber: trackingNumber('JOB'),
        fullName: String(req.body.fullName).trim(),
        nationalId: String(req.body.nationalId).trim(),
        phone: String(req.body.phone).trim(),
        email: String(req.body.email).trim().toLowerCase(),
        qualification: String(req.body.qualification).trim(),
        experience: nullableText(req.body.experience),
        jobType: String(req.body.jobType).trim(),
        preferredLocation: nullableText(req.body.preferredLocation),
        cvUrl,
        attachments: certificateUrl ? [certificateUrl] : [],
      },
    });
    await notify({ roleTarget: 'head', title: 'طلب توظيف جديد', message: `تم استلام طلب التوظيف ${application.applicationNumber}`, entityType: 'job', entityId: application.id });
    res.status(201).json({ applicationNumber: application.applicationNumber, trackingToken: application.trackingToken, status: application.status });
  } catch (error) { next(error); }
});

mosquesPublicRoutes.get('/jobs/track/:token', async (req, res, next) => {
  try {
    const application = await prisma.mosqueJobApplication.findUnique({
      where: { trackingToken: req.params.token },
      select: { applicationNumber: true, jobType: true, status: true, createdAt: true, updatedAt: true },
    });
    if (!application) return res.status(404).json({ message: 'رمز متابعة طلب التوظيف غير صحيح' });
    res.json(application);
  } catch (error) { next(error); }
});

router.get('/me', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    res.json({ role: context.role, siteId: context.siteId, personnelRole: context.assignment?.personnelRole || null, userId: req.authUser.id, isAdmin: req.authUser.role === 'admin', fullPermissionAccess: Boolean(context.fullPermissionAccess), accessSource: context.accessSource || 'assignment' });
  } catch (error) { next(error); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);

    if (context.role === 'university_member') {
      const sites = await prisma.mosqueSite.count({ where: { status: { not: 'temporarily_closed' } } });
      return res.json({
        role: context.role,
        siteId: null,
        personnelRole: null,
        stats: {
          sites, newRequests: 0, reviewRequests: 0, approvedRequests: 0, lateRequests: 0,
          openTickets: 0, pendingLeaves: 0, jobs: 0, managedSites: 0, assignedRequests: 0,
          urgentRequests: 0, newTickets: 0, myRequests: 0, myLeaves: 0,
        },
        recentRequests: [], recentTickets: [], linkedSite: null, managedSiteIds: [],
      });
    }

    const managedSiteIds = await getManagedSiteIds(req, context);
    const siteIdWhere = managedSiteIds === null ? {} : { siteId: { in: managedSiteIds } };
    const requestWhere = context.role === 'personnel'
      ? { ...siteIdWhere, submittedBy: req.authUser.id }
      : siteIdWhere;
    const leaveWhere = context.role === 'personnel'
      ? { ...siteIdWhere, applicantUserId: req.authUser.id }
      : siteIdWhere;
    const ticketWhere = ['head', 'supervisor'].includes(context.role) ? siteIdWhere : { id: { in: [] } };

    const [
      sites, newRequests, reviewRequests, approvedRequests, lateRequests, openTickets, pendingLeaves,
      jobs, assignedRequests, urgentRequests, newTickets, myRequests, myLeaves, recentRequests, recentTickets,
    ] = await Promise.all([
      managedSiteIds === null ? prisma.mosqueSite.count() : Promise.resolve(managedSiteIds.length),
      prisma.mosqueRequest.count({ where: { ...requestWhere, status: 'new' } }),
      prisma.mosqueRequest.count({ where: { ...requestWhere, status: 'under_review' } }),
      prisma.mosqueRequest.count({ where: { ...requestWhere, status: 'approved' } }),
      prisma.mosqueRequest.count({ where: { ...requestWhere, status: { in: ['new', 'under_review', 'approved', 'in_progress'] }, createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
      ['head', 'supervisor'].includes(context.role) ? prisma.mosqueTicket.count({ where: { ...ticketWhere, status: { notIn: ['closed', 'rejected'] } } }) : Promise.resolve(0),
      prisma.mosqueLeave.count({ where: { ...leaveWhere, status: { in: ['pending', 'under_review'] } } }),
      context.role === 'head' ? prisma.mosqueJobApplication.count({ where: { status: { not: 'archived' } } }) : Promise.resolve(0),
      context.role === 'supervisor' ? prisma.mosqueRequest.count({ where: { ...siteIdWhere, status: { in: ['new', 'under_review', 'approved', 'in_progress'] } } }) : Promise.resolve(0),
      ['head', 'supervisor'].includes(context.role) ? prisma.mosqueRequest.count({ where: { ...siteIdWhere, priority: 'urgent', status: { in: ['new', 'under_review', 'approved', 'in_progress'] } } }) : Promise.resolve(0),
      ['head', 'supervisor'].includes(context.role) ? prisma.mosqueTicket.count({ where: { ...ticketWhere, status: 'new' } }) : Promise.resolve(0),
      context.role === 'personnel' ? prisma.mosqueRequest.count({ where: { ...requestWhere, status: { notIn: ['closed', 'rejected'] } } }) : Promise.resolve(0),
      context.role === 'personnel' ? prisma.mosqueLeave.count({ where: { ...leaveWhere, status: { in: ['pending', 'under_review', 'approved'] } } }) : Promise.resolve(0),
      prisma.mosqueRequest.findMany({ where: requestWhere, include: { site: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 5 }),
      ['head', 'supervisor'].includes(context.role)
        ? prisma.mosqueTicket.findMany({ where: ticketWhere, include: { site: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 5 })
        : Promise.resolve([]),
    ]);

    const linkedSite = context.role === 'personnel' && context.siteId
      ? await prisma.mosqueSite.findUnique({
          where: { id: context.siteId },
          select: {
            id: true, publicToken: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true,
            campusLocation: true, area: true, capacity: true, latitude: true, longitude: true,
            mapUrl: true, status: true,
          },
        })
      : null;

    res.json({
      role: context.role,
      siteId: context.siteId,
      personnelRole: context.assignment?.personnelRole || null,
      stats: {
        sites, newRequests, reviewRequests, approvedRequests, lateRequests, openTickets, pendingLeaves, jobs,
        managedSites: context.role === 'supervisor' ? sites : 0,
        assignedRequests, urgentRequests, newTickets, myRequests, myLeaves,
      },
      recentRequests, recentTickets, linkedSite,
      managedSiteIds: context.role === 'supervisor' ? (managedSiteIds || []) : [],
    });
  } catch (error) { next(error); }
});

router.get('/sites', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    if (context.role === 'head') {
      const sites = await prisma.mosqueSite.findMany({
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      });
      return res.json(await enrichMosqueSitePersonnelNames(sites));
    }
    if (context.role === 'supervisor') {
      const sites = await prisma.mosqueSite.findMany({
        where: { supervisorUserId: req.authUser.id },
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      });
      return res.json(await enrichMosqueSitePersonnelNames(sites));
    }
    if (context.role === 'personnel') {
      if (!context.siteId) return res.json([]);
      const site = await prisma.mosqueSite.findUnique({
        where: { id: context.siteId },
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
      });
      const linkedSite = site ? await enrichMosqueSitePersonnelNames(site) : null;
      return res.json(linkedSite ? [linkedSite] : []);
    }
    return res.json(await prisma.mosqueSite.findMany({
      where: { status: { not: 'temporarily_closed' } },
      select: {
        id: true, publicToken: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true,
        campusLocation: true, area: true, capacity: true, latitude: true, longitude: true,
        mapUrl: true, status: true,
      },
      orderBy: { name: 'asc' },
    }));
  } catch (error) { next(error); }
});

router.post('/sites' , requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const input = siteSchema.parse(req.body);
    const site = await prisma.mosqueSite.create({
      data: {
        ...input,
        supervisorUserId: context.role === 'supervisor' ? req.authUser.id : input.supervisorUserId,
        createdBy: req.authUser.id,
      },
    });
    res.status(201).json(site);
  } catch (error) { next(error); }
});

router.put('/sites/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const current = await prisma.mosqueSite.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الموقع غير موجود' });
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, current.id, context);
    const input = siteSchema.parse(req.body);
    const site = await prisma.mosqueSite.update({
      where: { id: req.params.id },
      data: {
        ...input,
        supervisorUserId: context.role === 'supervisor' ? current.supervisorUserId : input.supervisorUserId,
      },
    });
    res.json(site);
  } catch (error) { next(error); }
});

router.delete('/sites/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const site = await prisma.mosqueSite.findUnique({ where: { id: req.params.id }, include: { _count: { select: { requests: true, tickets: true, leaves: true } } } });
    if (!site) return res.status(404).json({ message: 'الموقع غير موجود' });
    if (site._count.requests || site._count.tickets || site._count.leaves) {
      return res.status(409).json({ message: 'لا يمكن حذف موقع مرتبط بإجراءات. غيّر حالته إلى مغلق مؤقتًا بدل الحذف.' });
    }
    await prisma.mosqueSite.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) { next(error); }
});

// -----------------------------------------------------------------------------
// Field tours and visits. Every visit is linked to the existing MosqueSite
// record so the platform keeps one authoritative mosque/prayer-room registry.
// -----------------------------------------------------------------------------
const newFieldChecklist = () => FIELD_VISIT_CHECKLIST.map((item) => ({
  ...item,
  status: 'not_checked',
  priority: 'normal',
  resolutionStatus: 'new',
  beforeImages: [],
  afterImages: [],
}));

const fieldVisitInclude = {
  site: {
    select: {
      id: true, name: true, siteType: true, prayerRoomGender: true, city: true,
      district: true, campusLocation: true, status: true, publicToken: true,
    },
  },
  tour: { select: { id: true, tourNumber: true, title: true, scheduledDate: true, status: true } },
  items: { orderBy: [{ category: 'asc' }, { createdAt: 'asc' }] },
};

const fieldSiteScope = async (req, context) => {
  const managedSiteIds = await getManagedSiteIds(req, context);
  return managedSiteIds === null ? {} : { siteId: { in: managedSiteIds } };
};

router.get('/field-visits/checklist-template', requireRoles('head', 'supervisor'), (_req, res) => {
  res.json(newFieldChecklist());
});

router.get('/field-tours', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const scope = await fieldSiteScope(req, context);
    const tours = await prisma.mosqueFieldTour.findMany({
      where: context.role === 'head' ? {} : { visits: { some: scope } },
      include: {
        visits: {
          where: scope,
          include: {
            site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true, campusLocation: true } },
            _count: { select: { items: true } },
          },
          orderBy: { visitDate: 'asc' },
        },
      },
      orderBy: [{ scheduledDate: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(tours);
  } catch (error) { next(error); }
});

router.post('/field-tours', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const input = fieldTourSchema.parse(req.body);
    const siteIds = [...new Set(input.siteIds)];

    if (context.role === 'supervisor') {
      const managed = new Set(await getManagedSiteIds(req, context) || []);
      if (siteIds.some((siteId) => !managed.has(siteId))) {
        return res.status(403).json({ message: 'تتضمن الجولة موقعًا غير مسند إلى حساب المشرف الحالي' });
      }
    }

    const sites = await prisma.mosqueSite.findMany({ where: { id: { in: siteIds } }, select: { id: true } });
    if (sites.length !== siteIds.length) return res.status(400).json({ message: 'يتضمن نطاق الجولة مسجدًا أو مصلى غير موجود' });

    const created = await prisma.$transaction(async (tx) => {
      const tour = await tx.mosqueFieldTour.create({
        data: {
          tourNumber: trackingNumber('MTR'),
          title: input.title,
          scheduledDate: input.scheduledDate,
          scope: input.scope || null,
          teamMembers: input.teamMembers,
          status: input.status,
          notes: input.notes || null,
          createdBy: req.authUser.id,
        },
      });

      for (const siteId of siteIds) {
        await tx.mosqueFieldVisit.create({
          data: {
            visitNumber: trackingNumber('MVS'),
            tourId: tour.id,
            siteId,
            visitType: 'initial',
            visitDate: input.scheduledDate,
            teamMembers: input.teamMembers,
            workflowStatus: 'planned',
            createdBy: req.authUser.id,
            items: { create: newFieldChecklist().map(fieldVisitItemData) },
          },
        });
      }

      return tx.mosqueFieldTour.findUnique({
        where: { id: tour.id },
        include: {
          visits: {
            include: { site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true, campusLocation: true } }, _count: { select: { items: true } } },
            orderBy: { visitDate: 'asc' },
          },
        },
      });
    });

    res.status(201).json(created);
  } catch (error) { next(error); }
});

router.patch('/field-tours/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const current = await prisma.mosqueFieldTour.findUnique({ where: { id: req.params.id }, include: { visits: { select: { siteId: true } } } });
    if (!current) return res.status(404).json({ message: 'الجولة الميدانية غير موجودة' });
    if (context.role === 'supervisor') {
      const managed = new Set(await getManagedSiteIds(req, context) || []);
      if (current.visits.some((visit) => !managed.has(visit.siteId))) return res.status(403).json({ message: 'لا تملك صلاحية تعديل هذه الجولة' });
    }
    const input = z.object({
      status: z.enum(['scheduled', 'in_progress', 'completed', 'postponed', 'cancelled']),
      notes: z.string().trim().max(5000).optional().nullable(),
    }).parse(req.body);
    const updated = await prisma.mosqueFieldTour.update({ where: { id: current.id }, data: { status: input.status, notes: input.notes === undefined ? current.notes : input.notes } });
    res.json(updated);
  } catch (error) { next(error); }
});

router.get('/field-visits/summary', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const visitScope = await fieldSiteScope(req, context);
    const siteScope = context.role === 'head'
      ? {}
      : { id: { in: (await getManagedSiteIds(req, context)) || [] } };
    const openResolution = { notIn: ['resolved', 'closed'] };
    const [totalSites, visits, visitedSites, openItems, urgentItems, resolvedItems, overdueItems] = await Promise.all([
      prisma.mosqueSite.count({ where: siteScope }),
      prisma.mosqueFieldVisit.count({ where: visitScope }),
      prisma.mosqueFieldVisit.findMany({
        where: { ...visitScope, workflowStatus: { in: ['completed', 'follow_up', 'closed'] } },
        distinct: ['siteId'],
        select: { siteId: true },
      }),
      prisma.mosqueFieldVisitItem.count({ where: { visit: visitScope, status: 'needs_action', resolutionStatus: openResolution } }),
      prisma.mosqueFieldVisitItem.count({ where: { visit: visitScope, priority: 'urgent', resolutionStatus: openResolution } }),
      prisma.mosqueFieldVisitItem.count({ where: { visit: visitScope, resolutionStatus: { in: ['resolved', 'closed'] } } }),
      prisma.mosqueFieldVisitItem.count({ where: { visit: visitScope, dueDate: { lt: new Date() }, resolutionStatus: openResolution } }),
    ]);
    res.json({
      totalSites,
      visitedSites: visitedSites.length,
      remainingSites: Math.max(0, totalSites - visitedSites.length),
      coveragePercent: totalSites ? Math.round((visitedSites.length / totalSites) * 100) : 0,
      visits,
      openItems,
      urgentItems,
      resolvedItems,
      overdueItems,
    });
  } catch (error) { next(error); }
});

router.get('/field-visits', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const scope = await fieldSiteScope(req, context);
    const siteId = nullableText(req.query.siteId);
    const tourId = nullableText(req.query.tourId);
    const workflowStatus = nullableText(req.query.workflowStatus);
    const records = await prisma.mosqueFieldVisit.findMany({
      where: {
        ...scope,
        ...(siteId ? { siteId } : {}),
        ...(tourId ? { tourId } : {}),
        ...(workflowStatus ? { workflowStatus } : {}),
      },
      include: fieldVisitInclude,
      orderBy: [{ visitDate: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(records);
  } catch (error) { next(error); }
});

router.get('/field-visits/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const scope = await fieldSiteScope(req, context);
    const record = await prisma.mosqueFieldVisit.findFirst({ where: { id: req.params.id, ...scope }, include: fieldVisitInclude });
    if (!record) return res.status(404).json({ message: 'الزيارة الميدانية غير موجودة' });
    res.json(record);
  } catch (error) { next(error); }
});

router.post('/field-visits', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const input = fieldVisitSchema.parse(req.body);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, context);
    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });
    const items = input.items.length ? input.items : newFieldChecklist();
    const record = await prisma.mosqueFieldVisit.create({
      data: {
        visitNumber: trackingNumber('MVS'),
        tourId: input.tourId || null,
        siteId: input.siteId,
        visitType: input.visitType,
        visitDate: input.visitDate,
        departureAt: input.departureAt || null,
        representativeName: input.representativeName || null,
        teamMembers: input.teamMembers,
        overallStatus: input.overallStatus,
        priority: input.priority,
        workflowStatus: input.workflowStatus,
        generalNotes: input.generalNotes || null,
        recommendations: input.recommendations || null,
        attachments: input.attachments,
        createdBy: req.authUser.id,
        items: { create: items.map(fieldVisitItemData) },
      },
      include: fieldVisitInclude,
    });
    res.status(201).json(record);
  } catch (error) { next(error); }
});

router.put('/field-visits/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const current = await prisma.mosqueFieldVisit.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الزيارة الميدانية غير موجودة' });
    if (context.role === 'supervisor') {
      await assertSupervisorSiteAccess(req, current.siteId, context);
      if (req.body.siteId && req.body.siteId !== current.siteId) await assertSupervisorSiteAccess(req, req.body.siteId, context);
    }
    const input = fieldVisitSchema.parse(req.body);
    const record = await prisma.$transaction(async (tx) => {
      await tx.mosqueFieldVisitItem.deleteMany({ where: { visitId: current.id } });
      return tx.mosqueFieldVisit.update({
        where: { id: current.id },
        data: {
          tourId: input.tourId || null,
          siteId: input.siteId,
          visitType: input.visitType,
          visitDate: input.visitDate,
          departureAt: input.departureAt || null,
          representativeName: input.representativeName || null,
          teamMembers: input.teamMembers,
          overallStatus: input.overallStatus,
          priority: input.priority,
          workflowStatus: input.workflowStatus,
          generalNotes: input.generalNotes || null,
          recommendations: input.recommendations || null,
          attachments: input.attachments,
          items: { create: input.items.map(fieldVisitItemData) },
        },
        include: fieldVisitInclude,
      });
    });
    res.json(record);
  } catch (error) { next(error); }
});

router.delete('/field-visits/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueFieldVisit.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!current) return res.status(404).json({ message: 'الزيارة الميدانية غير موجودة' });

    await prisma.mosqueFieldVisit.delete({ where: { id: current.id } });
    res.status(204).send();
  } catch (error) { next(error); }
});

router.get('/requests', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    let where;
    if (context.role === 'head') where = {};
    else if (context.role === 'supervisor') {
      const ids = await getManagedSiteIds(req, context);
      where = { siteId: { in: ids || [] } };
    } else if (context.role === 'personnel' && context.siteId) {
      where = { siteId: context.siteId, submittedBy: req.authUser.id };
    } else return res.status(403).json({ message: 'طلبات الصيانة والاحتياجات الداخلية متاحة لمنسوبي الوحدة والمساجد فقط' });
    const items = await prisma.mosqueRequest.findMany({ where, include: { site: { select: { name: true, siteType: true } } }, orderBy: { createdAt: 'desc' } });
    res.json(await enrichMosqueApplicants(items, 'submittedBy'));
  } catch (error) { next(error); }
});

router.post('/requests', requireRoles('personnel'), async (req, res, next) => {
  try {
    const input = requestSchema.parse(req.body);
    const context = req.mosqueRole || await getModuleRole(req);
    if (!context.siteId || input.siteId !== context.siteId) {
      return res.status(403).json({ message: 'يمكن لمنسوب المسجد تقديم الطلب للمسجد أو الجامع أو المصلى المرتبط بحسابه فقط' });
    }
    const request = await prisma.mosqueRequest.create({ data: { ...input, requestNumber: trackingNumber('REQ'), submittedBy: req.authUser.id } });
    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { name: true } });
    await Promise.all([
      notify({ roleTarget: 'supervisor', siteId: input.siteId, title: 'طلب صيانة/احتياج جديد', message: `تم استلام الطلب ${request.requestNumber}${site?.name ? ` - ${site.name}` : ''}`, entityType: 'request', entityId: request.id }),
      notify({ roleTarget: 'head', siteId: input.siteId, title: 'طلب صيانة/احتياج جديد', message: `تم استلام الطلب ${request.requestNumber}${site?.name ? ` - ${site.name}` : ''}`, entityType: 'request', entityId: request.id }),
    ]);
    res.status(201).json(request);
  } catch (error) { next(error); }
});

router.patch('/requests/:id/status', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueRequest.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الطلب غير موجود' });
    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, current.siteId, context);
    const nextStatus = String(req.body.status || '').trim();
    ensureTransition(REQUEST_TRANSITIONS, current.status, nextStatus);
    requireDecisionReason(nextStatus, req.body);
    if (nextStatus === 'approved' && context.role !== 'head') return res.status(403).json({ message: 'اعتماد الطلب من صلاحية رئيس الوحدة' });
    if (nextStatus === 'completed' && !nullableText(req.body.completionEvidenceUrl) && !current.completionEvidenceUrl) {
      return res.status(400).json({ message: 'يلزم إرفاق ما يثبت الإنجاز قبل تحويل الطلب إلى مكتمل' });
    }
    const updated = await prisma.mosqueRequest.update({
      where: { id: current.id },
      data: {
        status: nextStatus,
        rejectionReason: nextStatus === 'rejected' ? nullableText(req.body.rejectionReason || req.body.note) : current.rejectionReason,
        returnReason: nextStatus === 'returned_for_edit' ? nullableText(req.body.returnReason || req.body.note) : current.returnReason,
        completionEvidenceUrl: nullableText(req.body.completionEvidenceUrl) || current.completionEvidenceUrl,
        notes: nullableText(req.body.note) || current.notes,
        assignedTo: nullableText(req.body.assignedTo) || current.assignedTo,
        closedAt: nextStatus === 'closed' ? new Date() : current.closedAt,
      },
      include: { site: { select: { name: true } } },
    });
    await notify({ userId: current.submittedBy, title: 'تحديث حالة الطلب', message: `أصبحت حالة ${current.requestNumber}: ${requestStatusLabels[nextStatus] || nextStatus}`, entityType: 'request', entityId: current.id });
    res.json(updated);
  } catch (error) { next(error); }
});

router.get('/tickets', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const ids = context.role === 'head' ? null : await getManagedSiteIds(req, context);
    const where = ids === null ? {} : { siteId: { in: ids || [] } };
    res.json(await prisma.mosqueTicket.findMany({ where, include: { site: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.patch('/tickets/:id/status', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueTicket.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'البلاغ غير موجود' });
    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, current.siteId, context);
    const nextStatus = String(req.body.status || '').trim();
    ensureTransition(TICKET_TRANSITIONS, current.status, nextStatus);
    if (nextStatus === 'rejected' && !nullableText(req.body.rejectionReason || req.body.note)) return res.status(400).json({ message: 'سبب رفض البلاغ إلزامي' });
    const updated = await prisma.mosqueTicket.update({ where: { id: current.id }, data: { status: nextStatus, assignedTo: nullableText(req.body.assignedTo) || current.assignedTo, rejectionReason: nextStatus === 'rejected' ? nullableText(req.body.rejectionReason || req.body.note) : current.rejectionReason, resolutionNote: nextStatus === 'resolved' ? nullableText(req.body.resolutionNote || req.body.note) : current.resolutionNote, notes: nullableText(req.body.note) || current.notes, closedAt: nextStatus === 'closed' ? new Date() : current.closedAt }, include: { site: { select: { name: true } } } });
    res.json(updated);
  } catch (error) { next(error); }
});

router.post('/tickets/:id/convert-to-request', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const ticket = await prisma.mosqueTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ message: 'البلاغ غير موجود' });
    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, ticket.siteId, context);
    if (ticket.convertedRequestId) return res.status(409).json({ message: 'تم تحويل هذا البلاغ إلى طلب مسبقًا' });
    const request = await prisma.mosqueRequest.create({ data: { requestNumber: trackingNumber('REQ'), siteId: ticket.siteId, requestType: nullableText(req.body.requestType) || 'maintenance', description: ticket.description, priority: nullableText(req.body.priority) || 'medium', attachments: ticket.attachmentUrl ? [ticket.attachmentUrl] : [], notes: `منشأ من البلاغ ${ticket.ticketNumber}`, submittedBy: req.authUser.id, status: 'under_review' } });
    await prisma.mosqueTicket.update({ where: { id: ticket.id }, data: { convertedRequestId: request.id, status: ticket.status === 'new' ? 'under_review' : ticket.status } });
    res.status(201).json(request);
  } catch (error) { next(error); }
});

router.get('/leaves', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    let where;
    if (context.role === 'head') where = {};
    else if (context.role === 'supervisor') {
      const ids = await getManagedSiteIds(req, context);
      where = { siteId: { in: ids || [] } };
    } else if (context.role === 'personnel' && context.siteId) {
      where = { siteId: context.siteId, applicantUserId: req.authUser.id };
    } else return res.status(403).json({ message: 'طلبات الإجازة والاعتذار متاحة لمنسوبي المساجد والمخولين فقط' });
    const items = await prisma.mosqueLeave.findMany({ where, include: { site: { select: { name: true } }, personnel: true }, orderBy: { createdAt: 'desc' } });
    res.json(await enrichMosqueApplicants(items, 'applicantUserId'));
  } catch (error) { next(error); }
});

router.post('/leaves', requireRoles('personnel'), async (req, res, next) => {
  try {
    const input = leaveSchema.parse(req.body);
    if (input.endDate < input.startDate) return res.status(400).json({ message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' });
    const context = req.mosqueRole || await getModuleRole(req);
    if (!context.siteId || input.siteId !== context.siteId) {
      return res.status(403).json({ message: 'يمكن لمنسوب المسجد تقديم الإجازة أو الاعتذار للموقع المرتبط بحسابه فقط' });
    }
    const overlap = await prisma.mosqueLeave.findFirst({ where: { siteId: input.siteId, replacementName: input.replacementName, status: { in: ['pending', 'under_review', 'approved'] }, startDate: { lte: input.endDate }, endDate: { gte: input.startDate } } });
    if (overlap) return res.status(409).json({ message: 'البديل المختار مرتبط بطلب آخر يتعارض مع هذه الفترة' });
    const applicantPersonnel = await prisma.mosquePersonnel.findFirst({
      where: { userId: req.authUser.id, siteId: input.siteId, active: true },
      select: { id: true },
    });
    const leave = await prisma.mosqueLeave.create({
      data: { ...input, personnelId: applicantPersonnel?.id || null, leaveNumber: trackingNumber('LEV'), applicantUserId: req.authUser.id },
    });
    const leaveSite = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { name: true } });
    await Promise.all([
      notify({ roleTarget: 'supervisor', siteId: input.siteId, title: 'طلب إجازة/اعتذار جديد', message: `تم استلام ${leave.leaveNumber}${leaveSite?.name ? ` - ${leaveSite.name}` : ''}`, entityType: 'leave', entityId: leave.id }),
      notify({ roleTarget: 'head', siteId: input.siteId, title: 'طلب إجازة/اعتذار جديد', message: `تم استلام ${leave.leaveNumber}${leaveSite?.name ? ` - ${leaveSite.name}` : ''}`, entityType: 'leave', entityId: leave.id }),
    ]);
    res.status(201).json(leave);
  } catch (error) { next(error); }
});

router.patch('/leaves/:id/status', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueLeave.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'طلب الإجازة غير موجود' });
    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, current.siteId, context);
    const nextStatus = String(req.body.status || '').trim();
    ensureTransition(LEAVE_TRANSITIONS, current.status, nextStatus);
    requireDecisionReason(nextStatus, req.body);
    if (nextStatus === 'approved' && context.role !== 'head') return res.status(403).json({ message: 'اعتماد الإجازة من صلاحية رئيس الوحدة' });
    const updated = await prisma.mosqueLeave.update({ where: { id: current.id }, data: { status: nextStatus, reviewerNote: nullableText(req.body.note) || current.reviewerNote, rejectionReason: nextStatus === 'rejected' ? nullableText(req.body.rejectionReason || req.body.note) : current.rejectionReason, returnReason: nextStatus === 'returned_for_edit' ? nullableText(req.body.returnReason || req.body.note) : current.returnReason, replacementName: nullableText(req.body.replacementName) || current.replacementName } });
    await notify({ userId: current.applicantUserId, title: 'تحديث طلب الإجازة', message: `تم تحديث حالة ${current.leaveNumber} إلى ${nextStatus}`, entityType: 'leave', entityId: current.id });
    res.json(updated);
  } catch (error) { next(error); }
});

router.get('/jobs', requireRoles('head', 'supervisor'), async (_req, res, next) => {
  try {
    res.json(await prisma.mosqueJobApplication.findMany({ orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.patch('/jobs/:id/status', requireRoles('head'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueJobApplication.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'طلب التوظيف غير موجود' });
    const nextStatus = String(req.body.status || '').trim();
    ensureTransition(JOB_TRANSITIONS, current.status, nextStatus);
    if (nextStatus === 'rejected' && !nullableText(req.body.note)) return res.status(400).json({ message: 'سبب الرفض الداخلي مطلوب' });
    const updated = await prisma.mosqueJobApplication.update({ where: { id: current.id }, data: { status: nextStatus, internalNotes: nullableText(req.body.note) || current.internalNotes, interviewAt: req.body.interviewAt ? new Date(req.body.interviewAt) : current.interviewAt } });
    res.json(updated);
  } catch (error) { next(error); }
});



// -----------------------------------------------------------------------------
// Quran warehouse & distribution stock ledger.
// Warehouses are the source of truth for central stock. Every receipt,
// distribution, return, damage or adjustment is posted as an immutable movement.
// Site system stock starts from the latest physical inventory snapshot and then
// applies subsequent distribution/return/site-withdrawal movements, keeping physical counts and
// accounting movements auditable without overwriting history.
// -----------------------------------------------------------------------------
const QURAN_WAREHOUSE_POSITIVE_TYPES = new Set(['receipt', 'return', 'adjustment_in']);
const QURAN_WAREHOUSE_NEGATIVE_TYPES = new Set(['distribution', 'warehouse_damage', 'adjustment_out']);
const QURAN_SITE_POSITIVE_TYPES = new Set(['distribution']);
const QURAN_SITE_NEGATIVE_TYPES = new Set(['return', 'site_withdrawal']);

const quranZeroCounts = () => ({ largeCount: 0, mediumCount: 0, smallCount: 0, totalCount: 0 });
const quranMovementCounts = (row) => ({
  largeCount: Number(row?.largeCount || 0),
  mediumCount: Number(row?.mediumCount || 0),
  smallCount: Number(row?.smallCount || 0),
  totalCount: Number(row?.totalCount ?? ((row?.largeCount || 0) + (row?.mediumCount || 0) + (row?.smallCount || 0))),
});
const addQuranCounts = (target, counts, sign = 1) => {
  target.largeCount += sign * counts.largeCount;
  target.mediumCount += sign * counts.mediumCount;
  target.smallCount += sign * counts.smallCount;
  target.totalCount += sign * counts.totalCount;
  return target;
};
const quranWarehouseBalanceFromRows = (rows) => {
  const balance = quranZeroCounts();
  for (const row of rows || []) {
    const sign = QURAN_WAREHOUSE_POSITIVE_TYPES.has(row.movementType) ? 1 : QURAN_WAREHOUSE_NEGATIVE_TYPES.has(row.movementType) ? -1 : 0;
    if (sign) addQuranCounts(balance, quranMovementCounts(row), sign);
  }
  return balance;
};
const quranSiteStockFromRows = (latestInventory, rows) => {
  const stock = latestInventory
    ? {
        largeCount: Number(latestInventory.largeCount || 0),
        mediumCount: Number(latestInventory.mediumCount || 0),
        smallCount: Number(latestInventory.smallCount || 0),
        totalCount: Number(latestInventory.largeCount || 0) + Number(latestInventory.mediumCount || 0) + Number(latestInventory.smallCount || 0),
      }
    : quranZeroCounts();
  const cutoff = latestInventory?.countedAt ? new Date(latestInventory.countedAt).getTime() : null;
  for (const row of rows || []) {
    if (cutoff != null && new Date(row.movementAt).getTime() <= cutoff) continue;
    const sign = QURAN_SITE_POSITIVE_TYPES.has(row.movementType) ? 1 : QURAN_SITE_NEGATIVE_TYPES.has(row.movementType) ? -1 : 0;
    if (sign) addQuranCounts(stock, quranMovementCounts(row), sign);
  }
  return stock;
};
const quranHasEnough = (balance, counts) => (
  balance.largeCount >= counts.largeCount &&
  balance.mediumCount >= counts.mediumCount &&
  balance.smallCount >= counts.smallCount
);
const quranShortage = (warehouse, balance) => ({
  largeCount: Math.max(Number(warehouse.minLargeCount || 0) - balance.largeCount, 0),
  mediumCount: Math.max(Number(warehouse.minMediumCount || 0) - balance.mediumCount, 0),
  smallCount: Math.max(Number(warehouse.minSmallCount || 0) - balance.smallCount, 0),
  totalCount:
    Math.max(Number(warehouse.minLargeCount || 0) - balance.largeCount, 0) +
    Math.max(Number(warehouse.minMediumCount || 0) - balance.mediumCount, 0) +
    Math.max(Number(warehouse.minSmallCount || 0) - balance.smallCount, 0),
});

const getQuranWarehouseBalance = async (client, warehouseId) => {
  const rows = await client.mosqueQuranStockMovement.findMany({
    where: { warehouseId },
    select: { movementType: true, largeCount: true, mediumCount: true, smallCount: true, totalCount: true },
  });
  return quranWarehouseBalanceFromRows(rows);
};

const getQuranSiteSystemStock = async (client, siteId) => {
  const latestInventory = await client.mosqueQuranInventory.findFirst({
    where: { siteId },
    orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
  });
  const movements = await client.mosqueQuranStockMovement.findMany({
    where: { siteId, movementType: { in: ['distribution', 'return', 'site_withdrawal'] } },
    orderBy: [{ movementAt: 'asc' }, { createdAt: 'asc' }],
  });
  return { latestInventory, systemStock: quranSiteStockFromRows(latestInventory, movements) };
};

const getQuranOpeningBaselineState = async () => {
  const [sites, baselineLogs, closedLog] = await Promise.all([
    prisma.mosqueSite.findMany({
      select: { id: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true, campusLocation: true, status: true },
      orderBy: [{ name: 'asc' }],
    }),
    prisma.auditLog.findMany({
      where: { module: 'mosques', action: QURAN_OPENING_BASELINE_SITE_ACTION },
      orderBy: [{ createdAt: 'asc' }],
    }),
    prisma.auditLog.findFirst({
      where: { module: 'mosques', action: QURAN_OPENING_BASELINE_CLOSED_ACTION },
      orderBy: [{ createdAt: 'desc' }],
    }),
  ]);

  const latestBySite = new Map();
  for (const log of baselineLogs) {
    if (!log.entityId) continue;
    latestBySite.set(log.entityId, log);
  }

  const items = sites.map((site) => {
    const log = latestBySite.get(site.id) || null;
    const details = log?.newData && typeof log.newData === 'object' ? log.newData : {};
    return {
      site,
      counted: Boolean(log),
      baseline: log ? {
        largeCount: Number(details.largeCount || 0),
        mediumCount: Number(details.mediumCount || 0),
        smallCount: Number(details.smallCount || 0),
        totalCount: Number(details.totalCount || 0),
        recommendedWithdrawalCount: Number(details.recommendedWithdrawalCount || 0),
        countedAt: details.countedAt || log.createdAt,
        countedByName: details.countedByName || log.username || log.userEmail || null,
        notes: details.notes || null,
        inventoryId: details.inventoryId || null,
      } : null,
    };
  });
  const countedSites = items.filter((item) => item.counted).length;
  return {
    closed: Boolean(closedLog),
    closedAt: closedLog?.createdAt || null,
    closedByName: closedLog?.username || closedLog?.userEmail || null,
    totalSites: items.length,
    countedSites,
    remainingSites: Math.max(items.length - countedSites, 0),
    items,
  };
};

router.get('/quran-stock/opening-baseline', requireRoles('head'), async (_req, res, next) => {
  try {
    res.json(await getQuranOpeningBaselineState());
  } catch (error) { next(error); }
});

router.post('/quran-stock/opening-baseline', requireRoles('head'), async (req, res, next) => {
  try {
    const currentState = await getQuranOpeningBaselineState();
    if (currentState.closed) return res.status(409).json({ message: 'تم اعتماد وإقفال الجرد التأسيسي، ولا يمكن تعديل الأرصدة الافتتاحية بعد الإقفال' });

    const input = quranOpeningBaselineSchema.parse(req.body || {});
    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true, name: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });

    const totalCount = input.largeCount + input.mediumCount + input.smallCount;
    if (input.recommendedWithdrawalCount > totalCount) {
      return res.status(400).json({ message: 'عدد المصاحف الموصى بسحبها لا يمكن أن يتجاوز إجمالي المصاحف الموجودة في الموقع' });
    }

    const countedAt = input.countedAt || new Date();
    const countedByName = req.authUser?.username || req.authUser?.email || null;
    const inventory = await prisma.$transaction(async (tx) => {
      const row = await tx.mosqueQuranInventory.create({
        data: {
          siteId: site.id,
          largeCount: input.largeCount,
          mediumCount: input.mediumCount,
          smallCount: input.smallCount,
          damagedCount: 0,
          neededCount: 0,
          countedAt,
          countedBy: req.authUser?.id || null,
          countedByName,
          notes: nullableText(input.notes),
        },
      });
      await tx.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: QURAN_OPENING_BASELINE_SITE_ACTION,
          module: 'mosques',
          entity: 'MosqueSite',
          entityId: site.id,
          entityLabel: site.name,
          description: `جرد تأسيسي للمصاحف — ${site.name} — الإجمالي ${totalCount}`,
          details: { siteId: site.id, inventoryId: row.id, recommendedWithdrawalCount: input.recommendedWithdrawalCount },
          newData: {
            inventoryId: row.id,
            siteId: site.id,
            largeCount: input.largeCount,
            mediumCount: input.mediumCount,
            smallCount: input.smallCount,
            totalCount,
            recommendedWithdrawalCount: input.recommendedWithdrawalCount,
            countedAt,
            countedByName,
            notes: nullableText(input.notes),
          },
        },
      });
      return row;
    });

    res.status(201).json({
      message: 'تم اعتماد الرصيد الافتتاحي للموقع دون الخصم من مكتبة المصاحف',
      inventory: { ...inventory, totalCount },
      state: await getQuranOpeningBaselineState(),
    });
  } catch (error) { next(error); }
});

router.post('/quran-stock/opening-baseline/close', requireRoles('head'), async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || '').trim();
    if (confirmation !== 'اعتماد الجرد التأسيسي') {
      return res.status(400).json({ message: 'اكتب عبارة «اعتماد الجرد التأسيسي» لتأكيد الإقفال النهائي' });
    }
    const state = await getQuranOpeningBaselineState();
    if (state.closed) return res.status(409).json({ message: 'الجرد التأسيسي معتمد ومقفل مسبقًا' });
    if (state.remainingSites > 0) {
      return res.status(409).json({ message: `لا يمكن إقفال الجرد التأسيسي قبل حصر جميع المواقع. المتبقي ${state.remainingSites} موقعًا` });
    }

    await prisma.auditLog.create({
      data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action: QURAN_OPENING_BASELINE_CLOSED_ACTION,
        module: 'mosques',
        entity: 'MosqueQuranOpeningBaseline',
        entityLabel: 'الجرد التأسيسي للمصاحف',
        description: `اعتماد وإقفال الجرد التأسيسي للمصاحف بعد حصر ${state.countedSites} موقعًا`,
        newData: { totalSites: state.totalSites, countedSites: state.countedSites, closedAt: new Date() },
      },
    });

    res.json({ message: 'تم اعتماد وإقفال الجرد التأسيسي للمصاحف. أي حركة لاحقة ستتم من خلال الإضافة من المكتبة أو السحب.', state: await getQuranOpeningBaselineState() });
  } catch (error) { next(error); }
});

router.get('/quran-stock/dashboard', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const managedIds = await getManagedSiteIds(req, context);
    const siteWhere = managedIds === null ? {} : { id: { in: managedIds } };

    const [warehouses, allWarehouseMovements, sites] = await Promise.all([
      prisma.mosqueQuranWarehouse.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
      prisma.mosqueQuranStockMovement.findMany({
        include: { warehouse: { select: { id: true, code: true, name: true } }, site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } } },
        orderBy: [{ movementAt: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.mosqueSite.findMany({
        where: siteWhere,
        select: { id: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true, campusLocation: true, quranTargetCount: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const warehouseRows = warehouses.map((warehouse) => {
      const movements = allWarehouseMovements.filter((row) => row.warehouseId === warehouse.id);
      const balance = quranWarehouseBalanceFromRows(movements);
      const shortage = quranShortage(warehouse, balance);
      return { ...warehouse, balance, shortage, lowStock: shortage.totalCount > 0 };
    });

    const siteIds = sites.map((site) => site.id);
    const [inventoryRows, siteMovementRows] = siteIds.length
      ? await Promise.all([
          prisma.mosqueQuranInventory.findMany({
            where: { siteId: { in: siteIds } },
            orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
          }),
          prisma.mosqueQuranStockMovement.findMany({
            where: { siteId: { in: siteIds }, movementType: { in: ['distribution', 'return', 'site_withdrawal'] } },
            orderBy: [{ movementAt: 'asc' }, { createdAt: 'asc' }],
          }),
        ])
      : [[], []];

    const latestBySite = new Map();
    for (const row of inventoryRows) if (!latestBySite.has(row.siteId)) latestBySite.set(row.siteId, row);
    const movementsBySite = new Map();
    for (const row of siteMovementRows) {
      if (!movementsBySite.has(row.siteId)) movementsBySite.set(row.siteId, []);
      movementsBySite.get(row.siteId).push(row);
    }

    const siteStock = sites.map((site) => {
      const latestInventory = latestBySite.get(site.id) || null;
      const movementRows = movementsBySite.get(site.id) || [];
      const systemStock = quranSiteStockFromRows(latestInventory, movementRows);
      const withdrawnStock = movementRows
        .filter((row) => row.movementType === 'site_withdrawal')
        .reduce((counts, row) => addQuranCounts(counts, quranMovementCounts(row), 1), quranZeroCounts());
      const targetCount = Math.max(0, Number(site.quranTargetCount || 0));
      const needCount = targetCount > 0 ? Math.max(targetCount - systemStock.totalCount, 0) : 0;
      const coveragePercent = targetCount > 0
        ? Math.min(100, Math.round((systemStock.totalCount / targetCount) * 100))
        : null;
      const needLevel = targetCount <= 0
        ? 'not_set'
        : needCount <= 0
          ? 'complete'
          : coveragePercent >= 85
            ? 'low'
            : coveragePercent >= 60
              ? 'medium'
              : 'high';
      return { site, latestInventory, systemStock, withdrawnStock, targetCount, needCount, coveragePercent, needLevel };
    });

    const summary = {
      warehouseTotal: warehouseRows.reduce((sum, row) => sum + row.balance.totalCount, 0),
      warehouseLarge: warehouseRows.reduce((sum, row) => sum + row.balance.largeCount, 0),
      warehouseMedium: warehouseRows.reduce((sum, row) => sum + row.balance.mediumCount, 0),
      warehouseSmall: warehouseRows.reduce((sum, row) => sum + row.balance.smallCount, 0),
      receivedTotal: allWarehouseMovements.filter((row) => row.movementType === 'receipt').reduce((sum, row) => sum + row.totalCount, 0),
      distributedTotal: allWarehouseMovements.filter((row) => row.movementType === 'distribution').reduce((sum, row) => sum + row.totalCount, 0),
      returnedTotal: allWarehouseMovements.filter((row) => row.movementType === 'return').reduce((sum, row) => sum + row.totalCount, 0),
      withdrawnTotal: allWarehouseMovements.filter((row) => row.movementType === 'site_withdrawal').reduce((sum, row) => sum + row.totalCount, 0),
      damagedTotal: allWarehouseMovements.filter((row) => row.movementType === 'warehouse_damage').reduce((sum, row) => sum + row.totalCount, 0),
      siteSystemTotal: siteStock.reduce((sum, row) => sum + row.systemStock.totalCount, 0),
      siteNeedTotal: siteStock.reduce((sum, row) => sum + Number(row.needCount || 0), 0),
      lowStockWarehouses: warehouseRows.filter((row) => row.lowStock).length,
      shortageTotal: warehouseRows.reduce((sum, row) => sum + row.shortage.totalCount, 0),
    };

    const visibleRecentMovements = context.role === 'head'
      ? allWarehouseMovements.slice(0, 80)
      : allWarehouseMovements.filter((row) => row.siteId && siteIds.includes(row.siteId)).slice(0, 80);

    res.json({ warehouses: warehouseRows, summary, sites: siteStock, recentMovements: visibleRecentMovements });
  } catch (error) { next(error); }
});

router.post('/quran-warehouses', requireRoles('head'), async (req, res, next) => {
  try {
    const input = quranWarehouseSchema.parse(req.body || {});
    const code = nullableText(input.code) || `QW-${new Date().getFullYear()}-${randomDigits(4)}`;
    const created = await prisma.mosqueQuranWarehouse.create({
      data: {
        code,
        name: input.name,
        location: nullableText(input.location),
        active: input.active !== false,
        minLargeCount: input.minLargeCount || 0,
        minMediumCount: input.minMediumCount || 0,
        minSmallCount: input.minSmallCount || 0,
        notes: nullableText(input.notes),
        createdBy: req.authUser?.id || null,
      },
    });
    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null, username: req.authUser?.username || null, userEmail: req.authUser?.email || null, userRole: req.authUser?.role || null,
        action: 'quran_warehouse_create', module: 'mosques', entity: 'MosqueQuranWarehouse', entityId: created.id, entityLabel: created.name,
        description: `إنشاء مستودع مصاحف: ${created.name}`, newData: created,
      } });
    } catch {}
    res.status(201).json({ ...created, balance: quranZeroCounts(), shortage: quranShortage(created, quranZeroCounts()), lowStock: quranShortage(created, quranZeroCounts()).totalCount > 0 });
  } catch (error) {
    if (error?.code === 'P2002') return res.status(409).json({ message: 'رمز المستودع مستخدم مسبقًا' });
    next(error);
  }
});

router.patch('/quran-warehouses/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const input = quranWarehouseSchema.partial().parse(req.body || {});
    const data = {};
    if (input.code !== undefined) data.code = nullableText(input.code);
    if (input.name !== undefined) data.name = input.name;
    if (input.location !== undefined) data.location = nullableText(input.location);
    if (input.active !== undefined) data.active = input.active;
    if (input.minLargeCount !== undefined) data.minLargeCount = input.minLargeCount;
    if (input.minMediumCount !== undefined) data.minMediumCount = input.minMediumCount;
    if (input.minSmallCount !== undefined) data.minSmallCount = input.minSmallCount;
    if (input.notes !== undefined) data.notes = nullableText(input.notes);
    const updated = await prisma.mosqueQuranWarehouse.update({ where: { id: req.params.id }, data });
    const balance = await getQuranWarehouseBalance(prisma, updated.id);
    const shortage = quranShortage(updated, balance);
    res.json({ ...updated, balance, shortage, lowStock: shortage.totalCount > 0 });
  } catch (error) {
    if (error?.code === 'P2002') return res.status(409).json({ message: 'رمز المستودع مستخدم مسبقًا' });
    next(error);
  }
});

router.get('/quran-stock/movements', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const managedIds = await getManagedSiteIds(req, context);
    const where = {};
    if (req.query.warehouseId) where.warehouseId = String(req.query.warehouseId);
    if (req.query.siteId) where.siteId = String(req.query.siteId);
    if (managedIds !== null) where.siteId = { in: managedIds };
    const rows = await prisma.mosqueQuranStockMovement.findMany({
      where,
      include: { warehouse: { select: { id: true, code: true, name: true } }, site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } } },
      orderBy: [{ movementAt: 'desc' }, { createdAt: 'desc' }],
      take: 300,
    });
    res.json(rows);
  } catch (error) { next(error); }
});

router.delete('/quran-warehouses/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const warehouse = await prisma.mosqueQuranWarehouse.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, _count: { select: { movements: true } } },
    });
    if (!warehouse) return res.status(404).json({ message: 'مكتبة المصاحف غير موجودة' });
    if (warehouse._count.movements > 0) {
      return res.status(409).json({
        message: 'لا يمكن حذف المكتبة لأنها مرتبطة بحركات مصاحف محفوظة. حفاظًا على السجل يمكنك تعديل المكتبة وإلغاء تفعيلها بدلًا من الحذف.',
      });
    }

    await prisma.mosqueQuranWarehouse.delete({ where: { id: warehouse.id } });
    try {
      await prisma.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          action: 'DELETE_QURAN_WAREHOUSE',
          module: 'mosques',
          entity: 'MosqueQuranWarehouse',
          entityId: warehouse.id,
          entityLabel: warehouse.name,
          description: `حذف مكتبة مصاحف: ${warehouse.name}`,
          details: { name: warehouse.name },
        },
      });
    } catch (auditError) {
      console.warn('Unable to create Quran warehouse deletion audit log:', auditError?.message || auditError);
    }
    res.status(204).send();
  } catch (error) { next(error); }
});

router.post('/quran-stock/reset', requireRoles('head'), async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || '').trim();
    if (confirmation !== 'تصفير مكتبة المصاحف') {
      return res.status(400).json({ message: 'لتنفيذ التصفير اكتب عبارة التأكيد: تصفير مكتبة المصاحف' });
    }

    const reset = await prisma.$transaction(async (tx) => {
      const [warehouses, movements, inventories, notifications] = await Promise.all([
        tx.mosqueQuranWarehouse.count(),
        tx.mosqueQuranStockMovement.count(),
        tx.mosqueQuranInventory.count(),
        tx.mosqueNotification.count({ where: { entityType: 'quran_stock_movement' } }),
      ]);

      // Delete dependent records first because stock movements restrict warehouse deletion.
      await tx.mosqueQuranStockMovement.deleteMany({});
      await tx.mosqueQuranInventory.deleteMany({});
      await tx.mosqueNotification.deleteMany({ where: { entityType: 'quran_stock_movement' } });
      await tx.mosqueQuranWarehouse.deleteMany({});
      await tx.auditLog.deleteMany({
        where: { module: 'mosques', action: { in: [QURAN_OPENING_BASELINE_SITE_ACTION, QURAN_OPENING_BASELINE_CLOSED_ACTION] } },
      });

      return { warehouses, movements, inventories, notifications };
    });

    try {
      await prisma.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: 'RESET_QURAN_LIBRARY',
          module: 'mosques',
          entity: 'MosqueQuranWarehouse',
          entityLabel: 'مكتبة المصاحف',
          description: 'تصفير كامل لمكتبة المصاحف وبيانات حركات وجرد المصاحف للبدء من الصفر',
          details: reset,
        },
      });
    } catch (auditError) {
      console.warn('Unable to create Quran library reset audit log:', auditError?.message || auditError);
    }

    res.json({
      message: 'تم تصفير مكتبة المصاحف بالكامل ويمكن الآن البدء من الصفر',
      reset,
    });
  } catch (error) { next(error); }
});

router.post('/quran-stock/movements', requireRoles('head'), async (req, res, next) => {
  try {
    const input = quranStockMovementSchema.parse(req.body || {});
    const counts = {
      largeCount: input.largeCount || 0,
      mediumCount: input.mediumCount || 0,
      smallCount: input.smallCount || 0,
      totalCount: (input.largeCount || 0) + (input.mediumCount || 0) + (input.smallCount || 0),
    };
    if (counts.totalCount <= 0) return res.status(400).json({ message: 'يجب إدخال كمية واحدة على الأقل من المصاحف' });
    if (['distribution', 'return', 'site_withdrawal'].includes(input.movementType) && !input.siteId) return res.status(400).json({ message: 'المسجد أو المصلى إلزامي في عمليات إضافة المصاحف والإرجاع والسحب' });

    const movement = await prisma.$transaction(async (tx) => {
      const warehouse = await tx.mosqueQuranWarehouse.findUnique({ where: { id: input.warehouseId } });
      if (!warehouse) {
        const error = new Error('مكتبة المصاحف غير موجودة'); error.statusCode = 404; throw error;
      }
      if (!warehouse.active && input.movementType !== 'return') {
        const error = new Error('مكتبة المصاحف غير مفعلة ولا تقبل حركات جديدة'); error.statusCode = 400; throw error;
      }

      if (QURAN_WAREHOUSE_NEGATIVE_TYPES.has(input.movementType)) {
        const balance = await getQuranWarehouseBalance(tx, warehouse.id);
        if (!quranHasEnough(balance, counts)) {
          const error = new Error(`الرصيد غير كافٍ. المتاح: كبير ${balance.largeCount}، متوسط ${balance.mediumCount}، صغير ${balance.smallCount}`);
          error.statusCode = 400; throw error;
        }
      }

      let site = null;
      if (input.siteId) {
        site = await tx.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true, name: true } });
        if (!site) { const error = new Error('المسجد أو المصلى غير موجود'); error.statusCode = 404; throw error; }
      }

      if (['return', 'site_withdrawal'].includes(input.movementType) && site) {
        const current = await getQuranSiteSystemStock(tx, site.id);
        if (!quranHasEnough(current.systemStock, counts)) {
          const error = new Error(`لا يمكن تسجيل كمية أكبر من الرصيد النظامي للموقع. الرصيد: كبير ${current.systemStock.largeCount}، متوسط ${current.systemStock.mediumCount}، صغير ${current.systemStock.smallCount}`);
          error.statusCode = 400; throw error;
        }
      }

      const created = await tx.mosqueQuranStockMovement.create({
        data: {
          movementNumber: trackingNumber('QMV'),
          movementType: input.movementType,
          warehouseId: warehouse.id,
          siteId: site?.id || null,
          ...counts,
          referenceNumber: nullableText(input.referenceNumber),
          movementAt: input.movementAt || new Date(),
          notes: nullableText(input.notes),
          createdBy: req.authUser?.id || null,
          createdByName: req.authUser?.username || req.authUser?.email || null,
        },
        include: { warehouse: { select: { id: true, code: true, name: true } }, site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } } },
      });
      return created;
    });

    if (movement.movementType === 'distribution' && movement.siteId) {
      await notify({ siteId: movement.siteId, title: 'تمت إضافة مصاحف للموقع', message: `تمت إضافة ${movement.totalCount} مصحفًا إلى ${movement.site?.name || 'الموقع'} من مكتبة المصاحف بموجب ${movement.movementNumber}`, entityType: 'quran_stock_movement', entityId: movement.id });
    }
    if (movement.movementType === 'site_withdrawal' && movement.siteId) {
      await notify({ siteId: movement.siteId, title: 'تم سحب مصاحف من الموقع', message: `تم سحب ${movement.totalCount} مصحفًا من ${movement.site?.name || 'الموقع'} بموجب ${movement.movementNumber}. الكمية المسحوبة لا تعاد تلقائيًا إلى رصيد مكتبة المصاحف.`, entityType: 'quran_stock_movement', entityId: movement.id });
    }

    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null, username: req.authUser?.username || null, userEmail: req.authUser?.email || null, userRole: req.authUser?.role || null,
        action: `quran_stock_${movement.movementType}`, module: 'mosques', entity: 'MosqueQuranStockMovement', entityId: movement.id, entityLabel: movement.movementNumber,
        description: `حركة مصاحف ${movement.movementNumber} — إجمالي ${movement.totalCount}`, newData: movement,
      } });
    } catch {}

    res.status(201).json(movement);
  } catch (error) { next(error); }
});

router.post('/quran-stock/movements/:id/reverse', requireRoles('head'), async (req, res, next) => {
  try {
    const reason = nullableText(req.body?.reason);
    if (!reason || reason.length < 3) return res.status(400).json({ message: 'سبب التراجع عن إضافة المصاحف إلزامي' });

    const original = await prisma.mosqueQuranStockMovement.findUnique({
      where: { id: req.params.id },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } },
      },
    });
    if (!original) return res.status(404).json({ message: 'حركة المصاحف غير موجودة' });
    if (original.movementType !== 'distribution') {
      return res.status(400).json({ message: 'التراجع المباشر متاح لحركات إضافة المصاحف للمواقع فقط' });
    }
    if (!original.siteId) return res.status(400).json({ message: 'حركة إضافة المصاحف غير مرتبطة بمسجد أو مصلى' });

    const priorReversal = await prisma.mosqueQuranStockMovement.findFirst({
      where: {
        movementType: 'return',
        warehouseId: original.warehouseId,
        siteId: original.siteId,
        referenceNumber: original.movementNumber,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (priorReversal) {
      return res.status(409).json({ message: `تم التراجع عن هذه الحركة مسبقًا بموجب ${priorReversal.movementNumber}` });
    }

    const counts = quranMovementCounts(original);
    const reversal = await prisma.$transaction(async (tx) => {
      const current = await getQuranSiteSystemStock(tx, original.siteId);
      if (!quranHasEnough(current.systemStock, counts)) {
        const error = new Error(`لا يمكن التراجع لأن رصيد الموقع الحالي أقل من كمية المصاحف المضافة. الرصيد: كبير ${current.systemStock.largeCount}، متوسط ${current.systemStock.mediumCount}، صغير ${current.systemStock.smallCount}`);
        error.statusCode = 400;
        throw error;
      }

      const warehouse = await tx.mosqueQuranWarehouse.findUnique({ where: { id: original.warehouseId } });
      if (!warehouse) {
        const error = new Error('مكتبة المصاحف المرتبطة بالحركة غير موجودة');
        error.statusCode = 404;
        throw error;
      }
      const site = await tx.mosqueSite.findUnique({
        where: { id: original.siteId },
        select: { id: true, name: true, siteType: true, prayerRoomGender: true },
      });
      if (!site) {
        const error = new Error('المسجد أو المصلى المرتبط بالحركة غير موجود');
        error.statusCode = 404;
        throw error;
      }

      return tx.mosqueQuranStockMovement.create({
        data: {
          movementNumber: trackingNumber('QMV'),
          movementType: 'return',
          warehouseId: original.warehouseId,
          siteId: original.siteId,
          ...counts,
          referenceNumber: original.movementNumber,
          movementAt: new Date(),
          notes: `تراجع عن حركة الصرف ${original.movementNumber} — ${reason}`,
          createdBy: req.authUser?.id || null,
          createdByName: req.authUser?.username || req.authUser?.email || null,
        },
        include: {
          warehouse: { select: { id: true, code: true, name: true } },
          site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } },
        },
      });
    });

    await notify({
      siteId: original.siteId,
      title: 'تم التراجع عن إضافة مصاحف',
      message: `تم عكس إضافة المصاحف ${original.movementNumber} وإعادة ${original.totalCount} مصحفًا إلى ${original.warehouse?.name || 'مكتبة المصاحف'} بموجب ${reversal.movementNumber}`,
      entityType: 'quran_stock_movement',
      entityId: reversal.id,
    });

    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action: 'quran_stock_reverse_distribution',
        module: 'mosques',
        entity: 'MosqueQuranStockMovement',
        entityId: original.id,
        entityLabel: original.movementNumber,
        description: `تراجع عن إضافة المصاحف ${original.movementNumber} بواسطة حركة الإرجاع ${reversal.movementNumber}`,
        details: { reason, reversalMovementId: reversal.id, reversalMovementNumber: reversal.movementNumber },
        oldData: original,
        newData: reversal,
      } });
    } catch {}

    res.status(201).json({ reversedMovementId: original.id, reversal });
  } catch (error) { next(error); }
});

// -----------------------------------------------------------------------------
// Quran inventory: each save creates a dated snapshot. The latest snapshot is
// used for current totals while the full history remains available for audit.
// damagedCount is a subset of the size counts, not an addition to total stock.
// -----------------------------------------------------------------------------
router.get('/quran-inventory', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    let siteWhere = {};
    if (context.role === 'supervisor') {
      const ids = await getManagedSiteIds(req, context);
      siteWhere = { id: { in: ids || [] } };
    } else if (context.role === 'personnel') {
      siteWhere = context.siteId ? { id: context.siteId } : { id: '__none__' };
    }

    const sites = await prisma.mosqueSite.findMany({
      where: siteWhere,
      select: { id: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true, campusLocation: true, status: true },
      orderBy: { name: 'asc' },
    });
    const siteIds = sites.map((site) => site.id);
    const snapshots = siteIds.length ? await prisma.mosqueQuranInventory.findMany({
      where: { siteId: { in: siteIds } },
      orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
    }) : [];

    const latestBySite = new Map();
    for (const row of snapshots) {
      if (!latestBySite.has(row.siteId)) latestBySite.set(row.siteId, row);
    }

    const normalize = (row) => row ? {
      ...row,
      totalCount: row.largeCount + row.mediumCount + row.smallCount,
    } : null;

    const items = sites.map((site) => ({ site, latest: normalize(latestBySite.get(site.id) || null) }));
    const summary = items.reduce((acc, item) => {
      acc.sites += 1;
      if (!item.latest) return acc;
      acc.countedSites += 1;
      acc.large += item.latest.largeCount;
      acc.medium += item.latest.mediumCount;
      acc.small += item.latest.smallCount;
      acc.damaged += item.latest.damagedCount;
      acc.needed += item.latest.neededCount;
      acc.total += item.latest.totalCount;
      return acc;
    }, { sites: 0, countedSites: 0, total: 0, large: 0, medium: 0, small: 0, damaged: 0, needed: 0 });

    res.json({ items, summary });
  } catch (error) { next(error); }
});

router.get('/quran-inventory/:siteId/history', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    await assertQuranInventorySiteAccess(req, req.params.siteId, context);
    const site = await prisma.mosqueSite.findUnique({ where: { id: req.params.siteId }, select: { id: true, name: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });
    const rows = await prisma.mosqueQuranInventory.findMany({
      where: { siteId: site.id },
      orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(rows.map((row) => ({ ...row, totalCount: row.largeCount + row.mediumCount + row.smallCount, site })));
  } catch (error) { next(error); }
});

router.post('/quran-inventory', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const input = quranInventorySchema.parse(req.body || {});
    await assertQuranInventorySiteAccess(req, input.siteId, context);
    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true, name: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });

    const totalCount = input.largeCount + input.mediumCount + input.smallCount;
    if (input.damagedCount > totalCount) {
      return res.status(400).json({ message: 'عدد المصاحف التالفة لا يمكن أن يتجاوز إجمالي المصاحف حسب الأحجام' });
    }

    const currentStock = await getQuranSiteSystemStock(prisma, site.id);
    if (currentStock.latestInventory && (
      input.largeCount > currentStock.systemStock.largeCount ||
      input.mediumCount > currentStock.systemStock.mediumCount ||
      input.smallCount > currentStock.systemStock.smallCount
    )) {
      return res.status(400).json({
        message: 'زيادة رصيد المسجد أو المصلى تتم من «إضافة من المكتبة» ليتم الخصم تلقائيًا من مكتبة المصاحف',
      });
    }

    const row = await prisma.mosqueQuranInventory.create({
      data: {
        siteId: input.siteId,
        largeCount: input.largeCount,
        mediumCount: input.mediumCount,
        smallCount: input.smallCount,
        damagedCount: input.damagedCount,
        neededCount: input.neededCount,
        countedAt: input.countedAt || new Date(),
        countedBy: req.authUser?.id || null,
        countedByName: req.authUser?.username || req.authUser?.email || null,
        notes: nullableText(input.notes),
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: 'quran_inventory_count',
          module: 'mosques',
          entity: 'quran_inventory',
          entityId: row.id,
          entityLabel: site.name,
          description: `تحديث جرد المصاحف — الإجمالي ${totalCount} — الاحتياج ${input.neededCount}`,
          details: { siteId: site.id, largeCount: input.largeCount, mediumCount: input.mediumCount, smallCount: input.smallCount, damagedCount: input.damagedCount, neededCount: input.neededCount, countedAt: row.countedAt },
          newData: row,
        },
      });
    } catch (auditError) {
      console.warn('Unable to write Quran inventory audit log:', auditError?.message || auditError);
    }

    res.status(201).json({ ...row, totalCount, site });
  } catch (error) { next(error); }
});

router.get('/personnel', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const ids = context.role === 'head' ? null : await getManagedSiteIds(req, context);
    const allowedPersonnelRoles = ['imam', 'muezzin', 'khateeb', 'collaborating_khateeb'];
    const where = ids === null
      ? { role: { in: allowedPersonnelRoles } }
      : { siteId: { in: ids || [] }, role: { in: allowedPersonnelRoles } };
    res.json(await prisma.mosquePersonnel.findMany({ where, include: { site: { select: { name: true } } }, orderBy: { name: 'asc' } }));
  } catch (error) { next(error); }
});

router.post('/personnel/account', requireRoles('head', 'supervisor'), async (req, res, next) => {
  let createdUserId = null;
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const input = personnelAccountSchema.parse(req.body);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, context);
    const email = input.email.trim().toLowerCase();
    let user = await prisma.appUser.findUnique({ where: { email } });
    let accountCreated = false;
    let activation = null;
    let temporaryPassword = null;

    if (user?.role === 'admin') return res.status(409).json({ message: 'لا يمكن تحويل حساب مسؤول النظام إلى منسوب مسجد' });
    const currentAssignment = user ? await prisma.mosqueUserAssignment.findUnique({ where: { userId: user.id } }) : null;
    if (currentAssignment && ['head', 'supervisor'].includes(normalizeMosqueRole(currentAssignment.role))) {
      return res.status(409).json({ message: 'الحساب مرتبط حاليًا بدور إداري داخل الوحدة ولا يمكن تحويله إلى منسوب مسجد مباشرة' });
    }

    if (!user) {
      activation = createMosqueActivationData();
      temporaryPassword = `IAU!${crypto.randomBytes(10).toString('base64url')}`;
      user = await prisma.appUser.create({
        data: {
          username: input.name,
          email,
          passwordHash: await hashPassword(temporaryPassword),
          role: 'employee',
          isActive: false,
          activationTokenHash: activation.tokenHash,
          activationExpires: activation.expiresAt,
          activationSentAt: new Date(),
          activatedAt: null,
          permissions: {
            create: [{ module: 'mosques', canView: true, canAdd: true, canEdit: false, canDelete: false, canPrint: false }],
          },
        },
      });
      createdUserId = user.id;
      accountCreated = true;
    } else {
      await prisma.userPermission.upsert({
        where: { userId_module: { userId: user.id, module: 'mosques' } },
        create: { userId: user.id, module: 'mosques', canView: true, canAdd: true, canEdit: false, canDelete: false, canPrint: false },
        update: { canView: true, canAdd: true },
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const assignment = await tx.mosqueUserAssignment.upsert({
        where: { userId: user.id },
        create: { userId: user.id, role: 'personnel', siteId: input.siteId, personnelRole: input.role },
        update: { role: 'personnel', siteId: input.siteId, personnelRole: input.role },
      });
      const existingPersonnel = await tx.mosquePersonnel.findFirst({ where: { userId: user.id } });
      const personnelData = {
        siteId: input.siteId,
        userId: user.id,
        name: input.name,
        role: input.role,
        mobile: nullableText(input.mobile),
        email,
        active: true,
      };
      const personnel = existingPersonnel
        ? await tx.mosquePersonnel.update({ where: { id: existingPersonnel.id }, data: personnelData, include: { site: { select: { name: true } } } })
        : await tx.mosquePersonnel.create({ data: personnelData, include: { site: { select: { name: true } } } });
      return { assignment, personnel };
    });

    const personnelRoleLabel = MOSQUE_PERSONNEL_ROLE_LABELS[input.role] || input.role;
    const personnelSiteName = result.personnel?.site?.name || 'الموقع المرتبط';
    const personnelLoginUrl = `${MOSQUE_FRONTEND_URL}/#/login`;

    try {
      await sendMosquePersonnelActivationEmail({
        to: user.email,
        username: user.username,
        personnelRoleLabel,
        siteName: personnelSiteName,
        initialPassword: temporaryPassword,
        activationUrl: accountCreated ? buildMosqueActivationUrl(activation.plainToken) : personnelLoginUrl,
        loginUrl: personnelLoginUrl,
        expiresInHours: MOSQUE_ACTIVATION_TOKEN_HOURS,
        includePassword: accountCreated,
      });
    } catch (emailError) {
      // الحساب الجديد لا يعتبر مكتمل الإنشاء دون نجاح إشعار التفعيل بالبريد.
      if (accountCreated) {
        await prisma.mosquePersonnel.deleteMany({ where: { userId: user.id } });
        await prisma.mosqueUserAssignment.deleteMany({ where: { userId: user.id } });
        await prisma.appUser.delete({ where: { id: user.id } });
      }
      throw emailError;
    }

    res.status(accountCreated ? 201 : 200).json({
      personnel: result.personnel,
      user: { uid: user.id, username: user.username, email: user.email, isActive: user.isActive },
      accountCreated,
      message: accountCreated
        ? 'تم إنشاء حساب منسوب المسجد وربطه بالموقع وإرسال رابط التفعيل وبيانات الدخول إلى بريده الإلكتروني.'
        : 'تم ربط الحساب الموجود بالمسجد والصفة التشغيلية وإرسال إشعار الدخول إلى بريده الإلكتروني.',
    });
  } catch (error) {
    if (createdUserId) {
      try {
        await prisma.mosquePersonnel.deleteMany({ where: { userId: createdUserId } });
        await prisma.mosqueUserAssignment.deleteMany({ where: { userId: createdUserId } });
        await prisma.appUser.deleteMany({ where: { id: createdUserId } });
      } catch {}
    }
    next(error);
  }
});

router.post('/personnel', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const allowedPersonnelRoles = ['imam', 'muezzin', 'khateeb', 'collaborating_khateeb'];
    const normalizedRole = String(req.body.role || 'imam').trim();
    const data = {
      siteId: String(req.body.siteId || ''), name: String(req.body.name || '').trim(), role: normalizedRole,
      userId: nullableText(req.body.userId), mobile: nullableText(req.body.mobile), email: nullableText(req.body.email), notes: nullableText(req.body.notes), active: req.body.active !== false,
    };
    if (!data.siteId || data.name.length < 2) return res.status(400).json({ message: 'الموقع والاسم مطلوبان' });
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, data.siteId, context);
    if (!allowedPersonnelRoles.includes(data.role)) return res.status(400).json({ message: 'الصفة يجب أن تكون إمام أو مؤذن أو خطيب أو خطيب متعاون' });
    if (data.userId) {
      const existing = await prisma.mosquePersonnel.findFirst({ where: { userId: data.userId } });
      if (existing) return res.status(409).json({ message: 'هذا المستخدم مرتبط مسبقًا بسجل منسوبي المساجد' });
    }
    res.status(201).json(await prisma.mosquePersonnel.create({ data }));
  } catch (error) { next(error); }
});

router.patch('/personnel/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const current = await prisma.mosquePersonnel.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'منسوب المسجد غير موجود' });

    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, current.siteId, context);

    const allowedPersonnelRoles = ['imam', 'muezzin', 'khateeb', 'collaborating_khateeb'];
    const siteId = String(req.body.siteId || current.siteId || '').trim();
    const name = String(req.body.name ?? current.name ?? '').trim();
    const personnelRole = String(req.body.role || current.role || 'imam').trim();
    const mobile = nullableText(req.body.mobile);
    const requestedEmail = nullableText(req.body.email);
    const email = requestedEmail ? requestedEmail.toLowerCase() : null;
    const active = req.body.active === undefined ? current.active : req.body.active !== false;

    if (!siteId || name.length < 2) return res.status(400).json({ message: 'الموقع والاسم مطلوبان' });
    if (!allowedPersonnelRoles.includes(personnelRole)) return res.status(400).json({ message: 'الصفة يجب أن تكون إمام أو مؤذن أو خطيب أو خطيب متعاون' });
    if (context.role === 'supervisor' && siteId !== current.siteId) await assertSupervisorSiteAccess(req, siteId, context);

    const updated = await prisma.$transaction(async (tx) => {
      let accountEmail = email;
      if (current.userId) {
        const user = await tx.appUser.findUnique({ where: { id: current.userId } });
        if (user) {
          if (user.role === 'admin') {
            const error = new Error('لا يمكن تعديل حساب مسؤول النظام من سجل منسوبي المساجد');
            error.statusCode = 409;
            throw error;
          }
          accountEmail = email || user.email;
          if (accountEmail !== user.email) {
            const duplicate = await tx.appUser.findUnique({ where: { email: accountEmail } });
            if (duplicate && duplicate.id !== user.id) {
              const error = new Error('البريد الإلكتروني مستخدم في حساب آخر');
              error.statusCode = 409;
              throw error;
            }
          }
          await tx.appUser.update({
            where: { id: user.id },
            data: { username: name, email: accountEmail },
          });
          await tx.mosqueUserAssignment.upsert({
            where: { userId: user.id },
            create: { userId: user.id, role: 'personnel', siteId, personnelRole },
            update: { role: 'personnel', siteId, personnelRole },
          });
        }
      }

      return tx.mosquePersonnel.update({
        where: { id: current.id },
        data: { siteId, name, role: personnelRole, mobile, email: accountEmail, active },
        include: { site: { select: { name: true } } },
      });
    });

    res.json(updated);
  } catch (error) { next(error); }
});

router.delete('/personnel/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const current = await prisma.mosquePersonnel.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'منسوب المسجد غير موجود' });

    await prisma.$transaction(async (tx) => {
      await tx.mosquePersonnel.delete({ where: { id: current.id } });
      if (current.userId) {
        const assignment = await tx.mosqueUserAssignment.findUnique({ where: { userId: current.userId } });
        if (assignment?.role === 'personnel') {
          await tx.mosqueUserAssignment.update({
            where: { userId: current.userId },
            data: { role: 'university_member', siteId: null, personnelRole: null },
          });
        }
      }
    });

    res.json({ id: current.id, detachedUserId: current.userId || null });
  } catch (error) { next(error); }
});

router.get('/staff-directory', async (req, res, next) => {
  if (req.authUser?.role !== 'admin') {
    return res.status(403).json({ message: 'دليل مستخدمي المنصة متاح لمسؤول النظام فقط' });
  }
  try {
    const [users, assignments] = await Promise.all([
      prisma.appUser.findMany({
        where: { role: 'employee' },
        select: { id: true, username: true, email: true, isActive: true },
        orderBy: { username: 'asc' },
      }),
      prisma.mosqueUserAssignment.findMany(),
    ]);
    const byUser = new Map(assignments.map((item) => [item.userId, item]));
    res.json(users.map((user) => {
      const assignment = byUser.get(user.id);
      return {
        uid: user.id, username: user.username, email: user.email, isActive: user.isActive,
        moduleRole: assignment ? normalizeMosqueRole(assignment.role) : 'university_member',
        siteId: assignment?.siteId || null,
        personnelRole: assignment?.personnelRole || null,
      };
    }));
  } catch (error) { next(error); }
});

router.get('/assignments', async (req, res, next) => {
  if (req.authUser?.role !== 'admin') {
    return res.status(403).json({ message: 'إدارة الأدوار التشغيلية لمستخدمي المنصة متاحة لمسؤول النظام فقط' });
  }
  try { res.json(await prisma.mosqueUserAssignment.findMany({ include: { site: { select: { name: true } } }, orderBy: { createdAt: 'asc' } })); } catch (error) { next(error); }
});

router.put('/assignments/:userId', async (req, res, next) => {
  if (req.authUser?.role !== 'admin') {
    return res.status(403).json({ message: 'تعديل الأدوار التشغيلية لمستخدمي المنصة متاح لمسؤول النظام فقط' });
  }
  try {
    const input = assignmentSchema.parse(req.body);
    if (input.role === 'viewer') input.role = 'university_member';
    const user = await prisma.appUser.findUnique({ where: { id: req.params.userId } });
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

    if (input.role === 'personnel') {
      if (!input.siteId) return res.status(400).json({ message: 'يجب تحديد المسجد أو المصلى للمنسوب' });
      if (!input.personnelRole) return res.status(400).json({ message: 'يجب تحديد الصفة: إمام أو مؤذن أو خطيب أو خطيب متعاون' });
      if (input.personnelRole === 'collaborator') input.personnelRole = 'collaborating_khateeb';
    } else {
      input.personnelRole = null;
      input.siteId = null;
    }

    const assignment = await prisma.$transaction(async (tx) => {
      const saved = await tx.mosqueUserAssignment.upsert({
        where: { userId: req.params.userId },
        create: { userId: req.params.userId, ...input },
        update: input,
        include: { site: { select: { name: true } } },
      });

      const existingPersonnel = await tx.mosquePersonnel.findFirst({ where: { userId: req.params.userId } });
      if (input.role === 'personnel') {
        const personnelData = {
          siteId: input.siteId,
          userId: req.params.userId,
          name: user.username || user.email,
          role: input.personnelRole,
          email: user.email || null,
          active: user.isActive !== false,
        };
        if (existingPersonnel) await tx.mosquePersonnel.update({ where: { id: existingPersonnel.id }, data: personnelData });
        else await tx.mosquePersonnel.create({ data: personnelData });
      } else if (existingPersonnel) {
        await tx.mosquePersonnel.update({ where: { id: existingPersonnel.id }, data: { active: false } });
      }
      return saved;
    });

    res.json(assignment);
  } catch (error) { next(error); }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    const filters = [{ userId: req.authUser.id }];
    if (context.role === 'head') filters.push({ roleTarget: 'head' });
    if (context.role === 'supervisor') {
      const ids = await getManagedSiteIds(req, context);
      filters.push({ roleTarget: 'supervisor', siteId: { in: ids || [] } });
      filters.push({ roleTarget: 'supervisor', siteId: null });
    }
    if (context.role === 'personnel' && context.siteId) filters.push({ roleTarget: 'personnel', siteId: context.siteId });
    const items = await prisma.mosqueNotification.findMany({
      where: { OR: filters },
      orderBy: { createdAt: 'desc' }, take: 50,
    });
    res.json(items);
  } catch (error) { next(error); }
});

router.patch('/notifications/:id/read', async (req, res, next) => {
  try {
    const notice = await prisma.mosqueNotification.findUnique({ where: { id: req.params.id } });
    if (!notice) return res.status(404).json({ message: 'الإشعار غير موجود' });
    const context = await getModuleRole(req);
    let allowed = notice.userId === req.authUser.id;
    if (!notice.userId && notice.roleTarget === context.role) {
      if (context.role === 'head') allowed = true;
      else if (context.role === 'personnel') allowed = !notice.siteId || notice.siteId === context.siteId;
      else if (context.role === 'supervisor') {
        const ids = await getManagedSiteIds(req, context);
        allowed = !notice.siteId || (ids || []).includes(notice.siteId);
      }
    }
    if (!allowed) return res.status(403).json({ message: 'لا تملك صلاحية تحديث هذا الإشعار' });
    res.json(await prisma.mosqueNotification.update({ where: { id: req.params.id }, data: { isRead: true } }));
  } catch (error) { next(error); }
});

router.get('/reports/summary', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const dateWhere = from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
    const ids = context.role === 'head' ? null : await getManagedSiteIds(req, context);
    const siteScope = ids === null ? {} : { siteId: { in: ids || [] } };
    const [sites, requests, tickets, leaves, jobs] = await Promise.all([
      prisma.mosqueSite.findMany({ where: ids === null ? {} : { id: { in: ids || [] } }, select: { id: true, name: true, city: true, district: true, siteType: true, status: true } }),
      prisma.mosqueRequest.findMany({ where: { ...siteScope, ...dateWhere }, select: { id: true, siteId: true, requestType: true, priority: true, status: true, createdAt: true, closedAt: true } }),
      prisma.mosqueTicket.findMany({ where: { ...siteScope, ...dateWhere }, select: { id: true, siteId: true, ticketType: true, status: true, createdAt: true, closedAt: true } }),
      prisma.mosqueLeave.findMany({ where: { ...siteScope, ...dateWhere }, select: { id: true, siteId: true, requestType: true, status: true, createdAt: true } }),
      context.role === 'head' ? prisma.mosqueJobApplication.findMany({ where: dateWhere, select: { id: true, jobType: true, status: true, createdAt: true } }) : Promise.resolve([]),
    ]);
    res.json({ sites, requests, tickets, leaves, jobs });
  } catch (error) { next(error); }
});


// -----------------------------------------------------------------------------
// Formal workflow administration for mosque-unit cards.
// Keeps operational records auditable: administrative edit, return, reject,
// approve, archive (soft-delete), resubmission, and history.
// -----------------------------------------------------------------------------
const MOSQUE_WORKFLOW_CONFIG = {
  request: { model: 'mosqueRequest', numberField: 'requestNumber', siteField: 'siteId' },
  ticket: { model: 'mosqueTicket', numberField: 'ticketNumber', siteField: 'siteId' },
  leave: { model: 'mosqueLeaveRequest', numberField: 'leaveNumber', siteField: 'siteId' },
  job: { model: 'mosqueJobApplication', numberField: 'applicationNumber', siteField: null },
};

const getWorkflowConfig = (kind) => MOSQUE_WORKFLOW_CONFIG[String(kind || '').trim()] || null;

const getWorkflowAllowedTransitions = (kind, status) => {
  const baseMap = kind === 'request' ? REQUEST_TRANSITIONS
    : kind === 'ticket' ? TICKET_TRANSITIONS
      : kind === 'leave' ? LEAVE_TRANSITIONS
        : JOB_TRANSITIONS;
  const allowed = [...(baseMap[status] || [])];

  // Official return-for-edit is also available for reports and recruitment.
  if (kind === 'ticket' && ['new', 'under_review', 'assigned'].includes(status) && !allowed.includes('returned_for_edit')) allowed.push('returned_for_edit');
  if (kind === 'ticket' && status === 'returned_for_edit') allowed.push('new');
  if (kind === 'job' && ['new', 'under_review', 'shortlisted', 'interview'].includes(status) && !allowed.includes('returned_for_edit')) allowed.push('returned_for_edit');
  if (kind === 'job' && status === 'returned_for_edit') allowed.push('new');

  // "Delete" in the UI is implemented as governance-safe archiving.
  if (status !== 'archived' && !allowed.includes('archived')) allowed.push('archived');
  return [...new Set(allowed)];
};

const workflowEntityLabel = (kind, item, config) => item?.[config.numberField] || `${kind}:${item?.id || ''}`;

const logMosqueWorkflowAction = async ({ req, kind, item, action, fromStatus = null, toStatus = null, note = null, previousData = null, newData = null }) => {
  try {
    const config = getWorkflowConfig(kind);
    await prisma.auditLog.create({
      data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action,
        module: 'mosques',
        entity: `${kind}_workflow`,
        entityId: item?.id || null,
        entityLabel: config ? workflowEntityLabel(kind, item, config) : item?.id || null,
        description: note || `${action}: ${fromStatus || '-'} -> ${toStatus || '-'}`,
        details: { kind, fromStatus, toStatus, note },
        previousData,
        newData,
      },
    });
  } catch (error) {
    console.warn('Unable to write mosque workflow audit log:', error?.message || error);
  }
};

const assertWorkflowAccess = async (req, kind, item, context) => {
  if (context.role === 'head') return;
  if (kind === 'job') {
    const error = new Error('طلبات التوظيف من صلاحية رئيس الوحدة');
    error.statusCode = 403;
    throw error;
  }
  if (context.role === 'supervisor') {
    await assertSupervisorSiteAccess(req, item.siteId, context);
    return;
  }
  const error = new Error('لا تملك صلاحية إدارة هذا الإجراء');
  error.statusCode = 403;
  throw error;
};

const sanitizeWorkflowEdit = (kind, input) => {
  const data = {};
  const copy = (key, transform = (v) => v) => {
    if (Object.prototype.hasOwnProperty.call(input, key)) data[key] = transform(input[key]);
  };
  const textOrNull = (value) => nullableText(value);

  if (kind === 'request') {
    copy('siteId', (v) => String(v || '').trim());
    copy('requestType', (v) => String(v || '').trim());
    copy('description', (v) => String(v || '').trim());
    copy('priority', (v) => String(v || '').trim());
    copy('notes', textOrNull);
    copy('assignedTo', textOrNull);
  } else if (kind === 'ticket') {
    copy('siteId', (v) => String(v || '').trim());
    copy('ticketType', (v) => String(v || '').trim());
    copy('description', (v) => String(v || '').trim());
    copy('reporterName', textOrNull);
    copy('reporterPhone', textOrNull);
    copy('reporterEmail', textOrNull);
    copy('assignedTo', textOrNull);
    copy('notes', textOrNull);
  } else if (kind === 'leave') {
    copy('siteId', (v) => String(v || '').trim());
    copy('requestType', (v) => String(v || '').trim());
    copy('startDate', (v) => new Date(v));
    copy('endDate', (v) => new Date(v));
    copy('reason', (v) => String(v || '').trim());
    copy('replacementName', (v) => String(v || '').trim());
    copy('replacementUserId', textOrNull);
    copy('notes', textOrNull);
  } else if (kind === 'job') {
    copy('fullName', (v) => String(v || '').trim());
    copy('phone', (v) => String(v || '').trim());
    copy('email', (v) => String(v || '').trim());
    copy('qualification', (v) => String(v || '').trim());
    copy('experience', textOrNull);
    copy('jobType', (v) => String(v || '').trim());
    copy('preferredLocation', textOrNull);
    copy('internalNotes', textOrNull);
    copy('interviewAt', (v) => v ? new Date(v) : null);
  }
  return data;
};

router.get('/workflow/:kind/:id/history', async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const config = getWorkflowConfig(kind);
    if (!config) return res.status(400).json({ message: 'نوع الإجراء غير مدعوم' });
    const rows = await prisma.auditLog.findMany({
      where: { module: 'mosques', entity: `${kind}_workflow`, entityId: req.params.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, action: true, description: true, details: true, username: true, userEmail: true, userRole: true, createdAt: true },
    });
    res.json(rows);
  } catch (error) { next(error); }
});

router.patch('/workflow/:kind/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const config = getWorkflowConfig(kind);
    if (!config) return res.status(400).json({ message: 'نوع الإجراء غير مدعوم' });
    const model = prisma[config.model];
    const current = await model.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الإجراء غير موجود' });
    const context = req.mosqueRole || await getModuleRole(req);
    await assertWorkflowAccess(req, kind, current, context);

    const data = sanitizeWorkflowEdit(kind, req.body || {});
    if (!Object.keys(data).length) return res.status(400).json({ message: 'لا توجد بيانات قابلة للتعديل' });
    const updated = await model.update({ where: { id: current.id }, data });
    await logMosqueWorkflowAction({ req, kind, item: updated, action: 'administrative_edit', fromStatus: current.status, toStatus: updated.status, note: nullableText(req.body?.adminNote) || 'تعديل إداري على بيانات المعاملة', previousData: current, newData: updated });
    res.json(updated);
  } catch (error) { next(error); }
});

router.patch('/workflow/:kind/:id/action', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const config = getWorkflowConfig(kind);
    if (!config) return res.status(400).json({ message: 'نوع الإجراء غير مدعوم' });
    const model = prisma[config.model];
    const current = await model.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الإجراء غير موجود' });
    const context = req.mosqueRole || await getModuleRole(req);
    await assertWorkflowAccess(req, kind, current, context);

    const nextStatus = String(req.body?.status || '').trim();
    const allowed = getWorkflowAllowedTransitions(kind, current.status);
    if (!allowed.includes(nextStatus)) return res.status(400).json({ message: `لا يمكن تغيير الحالة من ${current.status} إلى ${nextStatus}` });
    if (nextStatus === 'archived' && context.role !== 'head') return res.status(403).json({ message: 'الحذف/الأرشفة من صلاحية رئيس الوحدة' });
    if (nextStatus === 'approved' && ['request', 'leave'].includes(kind) && context.role !== 'head') return res.status(403).json({ message: 'الاعتماد من صلاحية رئيس الوحدة' });

    const note = nullableText(req.body?.note || req.body?.rejectionReason || req.body?.returnReason);
    if (['rejected', 'returned_for_edit', 'archived'].includes(nextStatus) && !note) {
      return res.status(400).json({ message: nextStatus === 'rejected' ? 'سبب الرفض إلزامي' : nextStatus === 'returned_for_edit' ? 'سبب الإعادة للتعديل إلزامي' : 'سبب الحذف/الأرشفة إلزامي' });
    }
    if (kind === 'request' && nextStatus === 'completed' && !nullableText(req.body?.completionEvidenceUrl) && !current.completionEvidenceUrl) {
      return res.status(400).json({ message: 'يلزم إرفاق ما يثبت الإنجاز قبل تحويل الطلب إلى مكتمل' });
    }

    const data = { status: nextStatus };
    if (kind === 'request') {
      if (nextStatus === 'rejected') data.rejectionReason = note;
      if (nextStatus === 'returned_for_edit') data.returnReason = note;
      if (req.body?.completionEvidenceUrl) data.completionEvidenceUrl = nullableText(req.body.completionEvidenceUrl);
      if (nextStatus === 'closed') data.closedAt = new Date();
    } else if (kind === 'ticket') {
      if (nextStatus === 'rejected') data.rejectionReason = note;
      if (note) data.resolutionNote = note;
      if (nextStatus === 'closed') data.closedAt = new Date();
    } else if (kind === 'leave') {
      if (note) data.reviewerNote = note;
      if (nextStatus === 'rejected') data.rejectionReason = note;
      if (nextStatus === 'returned_for_edit') data.returnReason = note;
    } else if (kind === 'job') {
      if (note) data.internalNotes = note;
      if (req.body?.interviewAt) data.interviewAt = new Date(req.body.interviewAt);
    }

    const updated = await model.update({ where: { id: current.id }, data });
    await logMosqueWorkflowAction({ req, kind, item: updated, action: nextStatus === 'archived' ? 'archive' : 'status_change', fromStatus: current.status, toStatus: nextStatus, note, previousData: current, newData: updated });

    // Notify authenticated internal submitters when a decision requires their attention.
    const targetUserId = kind === 'request' ? current.submittedBy : kind === 'leave' ? current.applicantUserId : null;
    if (targetUserId && ['returned_for_edit', 'rejected', 'approved'].includes(nextStatus)) {
      const title = nextStatus === 'returned_for_edit' ? 'إجراء معاد للتعديل' : nextStatus === 'rejected' ? 'تم رفض الإجراء' : 'تم اعتماد الإجراء';
      await notify({ userId: targetUserId, siteId: current.siteId || null, title, message: `${workflowEntityLabel(kind, current, config)} — ${note || requestStatusLabels[nextStatus] || nextStatus}`, entityType: kind, entityId: current.id });
    }

    res.json(updated);
  } catch (error) { next(error); }
});

router.patch('/workflow/:kind/:id/resubmit', requireRoles('personnel'), async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    if (!['request', 'leave'].includes(kind)) return res.status(400).json({ message: 'إعادة الإرسال متاحة للطلبات والإجازات الداخلية فقط' });
    const config = getWorkflowConfig(kind);
    const model = prisma[config.model];
    const current = await model.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الإجراء غير موجود' });
    if (current.status !== 'returned_for_edit') return res.status(400).json({ message: 'لا يمكن تعديل هذا الإجراء إلا بعد إعادته للتعديل' });

    const ownerId = kind === 'request' ? current.submittedBy : current.applicantUserId;
    if (!ownerId || ownerId !== req.authUser.id) return res.status(403).json({ message: 'لا يمكن تعديل إجراء مقدم من مستخدم آخر' });
    if (req.mosqueRole?.siteId && current.siteId !== req.mosqueRole.siteId) return res.status(403).json({ message: 'الإجراء لا يتبع الموقع المرتبط بحسابك' });

    const data = sanitizeWorkflowEdit(kind, req.body || {});
    data.status = kind === 'request' ? 'new' : 'pending';
    if (kind === 'request') {
      data.returnReason = null;
      data.rejectionReason = null;
      if (Array.isArray(req.body?.attachments) && req.body.attachments.length) data.attachments = req.body.attachments;
    } else {
      data.returnReason = null;
      data.rejectionReason = null;
      data.reviewerNote = null;
    }
    const updated = await model.update({ where: { id: current.id }, data });
    await logMosqueWorkflowAction({ req, kind, item: updated, action: 'resubmitted_after_return', fromStatus: current.status, toStatus: updated.status, note: nullableText(req.body?.resubmitNote) || 'تم تعديل الإجراء وإعادة إرساله', previousData: current, newData: updated });
    await notify({ roleTarget: 'supervisor', siteId: current.siteId, title: 'إجراء أعيد إرساله بعد التعديل', message: workflowEntityLabel(kind, updated, config), entityType: kind, entityId: current.id });
    res.json(updated);
  } catch (error) { next(error); }
});

export default router;
