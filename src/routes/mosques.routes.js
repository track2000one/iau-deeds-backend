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
  city: z.string().trim().optional().nullable(),
  district: z.string().trim().optional().nullable(),
  campusLocation: z.string().trim().optional().nullable(),
  area: z.coerce.number().nonnegative().optional().nullable(),
  capacity: z.coerce.number().int().nonnegative().optional().nullable(),
  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  mapUrl: z.string().trim().optional().nullable(),
  status: z.enum(['active', 'maintenance', 'temporarily_closed']).default('active'),
  imamName: z.string().trim().optional().nullable(),
  muezzinName: z.string().trim().optional().nullable(),
  khateebName: z.string().trim().optional().nullable(),
  contactPhone: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  images: z.array(z.string()).optional().default([]),
  supervisorUserId: z.string().trim().optional().nullable(),
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
        publicToken: true, name: true, siteType: true, city: true, district: true,
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
        publicToken: true, name: true, siteType: true, city: true, district: true,
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
      const images = Array.isArray(site.images) ? site.images : [];
      return images.map((imageUrl, index) => ({
        id: `site-${site.id}-${index + 1}`,
        title: site.name,
        imageUrl: normalizeGalleryImageUrl(imageUrl),
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
            id: true, publicToken: true, name: true, siteType: true, city: true, district: true,
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
      return res.json(await prisma.mosqueSite.findMany({
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      }));
    }
    if (context.role === 'supervisor') {
      return res.json(await prisma.mosqueSite.findMany({
        where: { supervisorUserId: req.authUser.id },
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      }));
    }
    if (context.role === 'personnel') {
      if (!context.siteId) return res.json([]);
      const site = await prisma.mosqueSite.findUnique({
        where: { id: context.siteId },
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
      });
      return res.json(site ? [site] : []);
    }
    return res.json(await prisma.mosqueSite.findMany({
      where: { status: { not: 'temporarily_closed' } },
      select: {
        id: true, publicToken: true, name: true, siteType: true, city: true, district: true,
        campusLocation: true, area: true, capacity: true, latitude: true, longitude: true,
        mapUrl: true, status: true,
      },
      orderBy: { name: 'asc' },
    }));
  } catch (error) { next(error); }
});

router.post('/sites', requireRoles('head', 'supervisor'), async (req, res, next) => {
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
    res.json(items);
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
    res.json(await prisma.mosqueLeave.findMany({ where, include: { site: { select: { name: true } }, personnel: true }, orderBy: { createdAt: 'desc' } }));
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
    const leave = await prisma.mosqueLeave.create({ data: { ...input, leaveNumber: trackingNumber('LEV'), applicantUserId: req.authUser.id } });
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

router.get('/personnel', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const ids = context.role === 'head' ? null : await getManagedSiteIds(req, context);
    const where = ids === null ? {} : { siteId: { in: ids || [] } };
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

router.get('/staff-directory', requireRoles('head', 'supervisor'), async (_req, res, next) => {
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

router.get('/assignments', requireRoles('head'), async (_req, res, next) => {
  try { res.json(await prisma.mosqueUserAssignment.findMany({ include: { site: { select: { name: true } } }, orderBy: { createdAt: 'asc' } })); } catch (error) { next(error); }
});

router.put('/assignments/:userId', requireRoles('head'), async (req, res, next) => {
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

export default router;
