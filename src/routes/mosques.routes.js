import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { uploadBufferToGoogleDrive } from '../services/googleDrive.js';

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

const getModuleRole = async (req) => {
  if (req.authUser?.role === 'admin') return { role: 'head', siteId: null, assignment: null };
  const assignment = await prisma.mosqueUserAssignment.findUnique({ where: { userId: req.authUser.id } });
  return assignment
    ? { role: assignment.role, siteId: assignment.siteId || null, assignment }
    : { role: 'viewer', siteId: null, assignment: null };
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
  siteType: z.enum(['mosque', 'prayer_room']).default('mosque'),
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
  role: z.enum(['head', 'supervisor', 'personnel', 'viewer']),
  siteId: z.string().optional().nullable(),
  personnelRole: z.enum(['imam', 'muezzin', 'khateeb', 'collaborator']).optional().nullable(),
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

mosquesPublicRoutes.get('/sites', async (_req, res, next) => {
  try {
    const sites = await prisma.mosqueSite.findMany({
      where: { status: { not: 'temporarily_closed' } },
      select: {
        publicToken: true, name: true, siteType: true, city: true, district: true,
        campusLocation: true, latitude: true, longitude: true, mapUrl: true, status: true,
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
        campusLocation: true, latitude: true, longitude: true, mapUrl: true, status: true,
      },
    });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });
    res.json(site);
  } catch (error) { next(error); }
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
    res.json({ role: context.role, siteId: context.siteId, userId: req.authUser.id, isAdmin: req.authUser.role === 'admin' });
  } catch (error) { next(error); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    const siteScope = context.role === 'personnel' && context.siteId ? { siteId: context.siteId } : {};
    const [sites, newRequests, reviewRequests, approvedRequests, lateRequests, openTickets, pendingLeaves, jobs, recentRequests, recentTickets] = await Promise.all([
      prisma.mosqueSite.count(),
      prisma.mosqueRequest.count({ where: { ...siteScope, status: 'new' } }),
      prisma.mosqueRequest.count({ where: { ...siteScope, status: 'under_review' } }),
      prisma.mosqueRequest.count({ where: { ...siteScope, status: 'approved' } }),
      prisma.mosqueRequest.count({ where: { ...siteScope, status: { in: ['new', 'under_review', 'approved', 'in_progress'] }, createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
      prisma.mosqueTicket.count({ where: { ...siteScope, status: { notIn: ['closed', 'rejected'] } } }),
      prisma.mosqueLeave.count({ where: { ...siteScope, status: { in: ['pending', 'under_review'] } } }),
      context.role === 'head' ? prisma.mosqueJobApplication.count({ where: { status: { not: 'archived' } } }) : Promise.resolve(0),
      prisma.mosqueRequest.findMany({ where: siteScope, include: { site: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 5 }),
      prisma.mosqueTicket.findMany({ where: siteScope, include: { site: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 5 }),
    ]);
    res.json({ role: context.role, siteId: context.siteId, stats: { sites, newRequests, reviewRequests, approvedRequests, lateRequests, openTickets, pendingLeaves, jobs }, recentRequests, recentTickets });
  } catch (error) { next(error); }
});

router.get('/sites', async (_req, res, next) => {
  try {
    const sites = await prisma.mosqueSite.findMany({
      include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    res.json(sites);
  } catch (error) { next(error); }
});

router.post('/sites', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const input = siteSchema.parse(req.body);
    const site = await prisma.mosqueSite.create({ data: { ...input, createdBy: req.authUser.id } });
    res.status(201).json(site);
  } catch (error) { next(error); }
});

router.put('/sites/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const input = siteSchema.parse(req.body);
    const site = await prisma.mosqueSite.update({ where: { id: req.params.id }, data: input });
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
    const where = context.role === 'personnel' && context.siteId ? { siteId: context.siteId } : {};
    const items = await prisma.mosqueRequest.findMany({ where, include: { site: { select: { name: true, siteType: true } } }, orderBy: { createdAt: 'desc' } });
    res.json(items);
  } catch (error) { next(error); }
});

router.post('/requests', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const input = requestSchema.parse(req.body);
    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'personnel' && context.siteId && input.siteId !== context.siteId) {
      return res.status(403).json({ message: 'يمكن لمنسوب المسجد تقديم طلب للموقع المرتبط به فقط' });
    }
    const request = await prisma.mosqueRequest.create({ data: { ...input, requestNumber: trackingNumber('REQ'), submittedBy: req.authUser.id } });
    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { name: true } });
    await notify({ roleTarget: 'supervisor', siteId: input.siteId, title: 'طلب جديد', message: `تم إنشاء الطلب ${request.requestNumber}${site?.name ? ` - ${site.name}` : ''}`, entityType: 'request', entityId: request.id });
    res.status(201).json(request);
  } catch (error) { next(error); }
});

router.patch('/requests/:id/status', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueRequest.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الطلب غير موجود' });
    const nextStatus = String(req.body.status || '').trim();
    ensureTransition(REQUEST_TRANSITIONS, current.status, nextStatus);
    requireDecisionReason(nextStatus, req.body);
    const role = req.mosqueRole?.role || (await getModuleRole(req)).role;
    if (nextStatus === 'approved' && role !== 'head') return res.status(403).json({ message: 'اعتماد الطلب من صلاحية رئيس الوحدة' });
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

router.get('/tickets', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    const where = context.role === 'personnel' && context.siteId ? { siteId: context.siteId } : {};
    res.json(await prisma.mosqueTicket.findMany({ where, include: { site: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.patch('/tickets/:id/status', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueTicket.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'البلاغ غير موجود' });
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
    if (ticket.convertedRequestId) return res.status(409).json({ message: 'تم تحويل هذا البلاغ إلى طلب مسبقًا' });
    const request = await prisma.mosqueRequest.create({ data: { requestNumber: trackingNumber('REQ'), siteId: ticket.siteId, requestType: nullableText(req.body.requestType) || 'maintenance', description: ticket.description, priority: nullableText(req.body.priority) || 'medium', attachments: ticket.attachmentUrl ? [ticket.attachmentUrl] : [], notes: `منشأ من البلاغ ${ticket.ticketNumber}`, submittedBy: req.authUser.id, status: 'under_review' } });
    await prisma.mosqueTicket.update({ where: { id: ticket.id }, data: { convertedRequestId: request.id, status: ticket.status === 'new' ? 'under_review' : ticket.status } });
    res.status(201).json(request);
  } catch (error) { next(error); }
});

router.get('/leaves', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    const where = context.role === 'personnel' && context.siteId ? { siteId: context.siteId, applicantUserId: req.authUser.id } : {};
    res.json(await prisma.mosqueLeave.findMany({ where, include: { site: { select: { name: true } }, personnel: true }, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.post('/leaves', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const input = leaveSchema.parse(req.body);
    if (input.endDate < input.startDate) return res.status(400).json({ message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' });
    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'personnel' && context.siteId && input.siteId !== context.siteId) return res.status(403).json({ message: 'الموقع غير مرتبط بحسابك' });
    const overlap = await prisma.mosqueLeave.findFirst({ where: { siteId: input.siteId, replacementName: input.replacementName, status: { in: ['pending', 'under_review', 'approved'] }, startDate: { lte: input.endDate }, endDate: { gte: input.startDate } } });
    if (overlap) return res.status(409).json({ message: 'البديل المختار مرتبط بطلب آخر يتعارض مع هذه الفترة' });
    const leave = await prisma.mosqueLeave.create({ data: { ...input, leaveNumber: trackingNumber('LEV'), applicantUserId: req.authUser.id } });
    await notify({ roleTarget: 'supervisor', siteId: input.siteId, title: 'طلب إجازة/اعتذار', message: `طلب جديد ${leave.leaveNumber}`, entityType: 'leave', entityId: leave.id });
    res.status(201).json(leave);
  } catch (error) { next(error); }
});

router.patch('/leaves/:id/status', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueLeave.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'طلب الإجازة غير موجود' });
    const nextStatus = String(req.body.status || '').trim();
    ensureTransition(LEAVE_TRANSITIONS, current.status, nextStatus);
    requireDecisionReason(nextStatus, req.body);
    const role = req.mosqueRole?.role || (await getModuleRole(req)).role;
    if (nextStatus === 'approved' && role !== 'head') return res.status(403).json({ message: 'اعتماد الإجازة من صلاحية رئيس الوحدة' });
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

router.get('/personnel', async (_req, res, next) => {
  try { res.json(await prisma.mosquePersonnel.findMany({ include: { site: { select: { name: true } } }, orderBy: { name: 'asc' } })); } catch (error) { next(error); }
});

router.post('/personnel', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const data = {
      siteId: String(req.body.siteId || ''), name: String(req.body.name || '').trim(), role: String(req.body.role || 'collaborator'),
      userId: nullableText(req.body.userId), mobile: nullableText(req.body.mobile), email: nullableText(req.body.email), notes: nullableText(req.body.notes), active: req.body.active !== false,
    };
    if (!data.siteId || data.name.length < 2) return res.status(400).json({ message: 'الموقع والاسم مطلوبان' });
    res.status(201).json(await prisma.mosquePersonnel.create({ data }));
  } catch (error) { next(error); }
});

router.get('/assignments', requireRoles('head'), async (_req, res, next) => {
  try { res.json(await prisma.mosqueUserAssignment.findMany({ include: { site: { select: { name: true } } }, orderBy: { createdAt: 'asc' } })); } catch (error) { next(error); }
});

router.put('/assignments/:userId', requireRoles('head'), async (req, res, next) => {
  try {
    const input = assignmentSchema.parse(req.body);
    const assignment = await prisma.mosqueUserAssignment.upsert({
      where: { userId: req.params.userId },
      create: { userId: req.params.userId, ...input },
      update: input,
      include: { site: { select: { name: true } } },
    });
    res.json(assignment);
  } catch (error) { next(error); }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    const filters = [{ userId: req.authUser.id }, { roleTarget: context.role }];
    if (context.siteId) filters.push({ siteId: context.siteId });
    const items = await prisma.mosqueNotification.findMany({
      where: { OR: filters },
      orderBy: { createdAt: 'desc' }, take: 50,
    });
    res.json(items);
  } catch (error) { next(error); }
});

router.patch('/notifications/:id/read', async (req, res, next) => {
  try { res.json(await prisma.mosqueNotification.update({ where: { id: req.params.id }, data: { isRead: true } })); } catch (error) { next(error); }
});

router.get('/reports/summary', async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const dateWhere = from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
    const [sites, requests, tickets, leaves, jobs] = await Promise.all([
      prisma.mosqueSite.findMany({ select: { id: true, name: true, city: true, district: true, siteType: true, status: true } }),
      prisma.mosqueRequest.findMany({ where: dateWhere, select: { id: true, siteId: true, requestType: true, priority: true, status: true, createdAt: true, closedAt: true } }),
      prisma.mosqueTicket.findMany({ where: dateWhere, select: { id: true, siteId: true, ticketType: true, status: true, createdAt: true, closedAt: true } }),
      prisma.mosqueLeave.findMany({ where: dateWhere, select: { id: true, siteId: true, requestType: true, status: true, createdAt: true } }),
      prisma.mosqueJobApplication.findMany({ where: dateWhere, select: { id: true, jobType: true, status: true, createdAt: true } }),
    ]);
    res.json({ sites, requests, tickets, leaves, jobs });
  } catch (error) { next(error); }
});

export default router;
