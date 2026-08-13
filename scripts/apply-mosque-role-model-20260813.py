from pathlib import Path

path = Path('src/routes/mosques.routes.js')
s = path.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global s
    if old not in s:
        raise RuntimeError(f'Anchor not found: {label}')
    s = s.replace(old, new, 1)


def replace_block(start, end, new, label):
    global s
    a = s.find(start)
    if a < 0:
        raise RuntimeError(f'Start anchor not found: {label}')
    b = s.find(end, a)
    if b < 0:
        raise RuntimeError(f'End anchor not found: {label}')
    s = s[:a] + new + '\n\n' + s[b:]

# Imports required to create linked mosque-personnel accounts.
replace_once(
    "import { uploadBufferToGoogleDrive } from '../services/googleDrive.js';",
    "import { uploadBufferToGoogleDrive } from '../services/googleDrive.js';\nimport { hashPassword } from '../security/auth.js';\nimport { sendAccountActivationEmail } from '../services/email.service.js';",
    'imports',
)

# Activation/account helpers and normalized operational roles.
old_role_helpers = """const getModuleRole = async (req) => {
  if (req.authUser?.role === 'admin') return { role: 'head', siteId: null, assignment: null };
  const assignment = await prisma.mosqueUserAssignment.findUnique({ where: { userId: req.authUser.id } });
  return assignment
    ? { role: assignment.role, siteId: assignment.siteId || null, assignment }
    : { role: 'viewer', siteId: null, assignment: null };
};
"""
new_role_helpers = """const MOSQUE_ACTIVATION_TOKEN_HOURS = Math.max(1, Number(process.env.ACCOUNT_ACTIVATION_TOKEN_HOURS || 24));
const MOSQUE_FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\\/+$/, '');
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

const getModuleRole = async (req) => {
  if (req.authUser?.role === 'admin') return { role: 'head', siteId: null, assignment: null };
  const assignment = await prisma.mosqueUserAssignment.findUnique({ where: { userId: req.authUser.id } });
  return assignment
    ? { role: normalizeMosqueRole(assignment.role), siteId: assignment.siteId || null, assignment }
    : { role: 'university_member', siteId: null, assignment: null };
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
"""
replace_once(old_role_helpers, new_role_helpers, 'role helpers')

replace_once(
    "siteType: z.enum(['mosque', 'prayer_room']).default('mosque'),",
    "siteType: z.enum(['mosque', 'jami', 'prayer_room']).default('mosque'),",
    'site type enum',
)
replace_once(
    "role: z.enum(['head', 'supervisor', 'personnel', 'viewer']),",
    "role: z.enum(['head', 'supervisor', 'personnel', 'university_member', 'viewer']),",
    'assignment role enum',
)

assignment_schema_anchor = """const assignmentSchema = z.object({
  role: z.enum(['head', 'supervisor', 'personnel', 'university_member', 'viewer']),
  siteId: z.string().optional().nullable(),
  personnelRole: z.enum(['imam', 'muezzin', 'khateeb', 'collaborating_khateeb', 'collaborator']).optional().nullable(),
});
"""
personnel_account_schema = assignment_schema_anchor + """

const personnelAccountSchema = z.object({
  siteId: z.string().min(1),
  name: z.string().trim().min(2),
  role: z.enum(['imam', 'muezzin', 'khateeb', 'collaborating_khateeb']),
  mobile: z.string().trim().optional().nullable(),
  email: z.string().email(),
});
"""
replace_once(assignment_schema_anchor, personnel_account_schema, 'personnel account schema')

# Public site data remains non-sensitive but includes enough general information for QR visitors.
s = s.replace(
    "campusLocation: true, latitude: true, longitude: true, mapUrl: true, status: true,",
    "campusLocation: true, area: true, capacity: true, latitude: true, longitude: true, mapUrl: true, status: true,",
)

# Role-aware dashboard.
dashboard = """router.get('/dashboard', async (req, res, next) => {
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
});"""
replace_block("router.get('/dashboard'", "router.get('/sites'", dashboard, 'dashboard')

# Site access model: head=all, supervisor=assigned sites, personnel=linked site, university member=public fields only.
sites_block = """router.get('/sites', async (req, res, next) => {
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
});"""
replace_block("router.get('/sites'", "router.get('/requests'", sites_block, 'sites routes')

requests_block = """router.get('/requests', async (req, res, next) => {
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

router.post('/requests', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const input = requestSchema.parse(req.body);
    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'personnel') {
      if (!context.siteId || input.siteId !== context.siteId) return res.status(403).json({ message: 'يمكن لمنسوب المسجد تقديم الطلب للموقع المرتبط بحسابه فقط' });
    }
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, context);
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
});"""
replace_block("router.get('/requests'", "router.get('/tickets'", requests_block, 'request routes')

tickets_block = """router.get('/tickets', requireRoles('head', 'supervisor'), async (req, res, next) => {
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
});"""
replace_block("router.get('/tickets'", "router.get('/leaves'", tickets_block, 'ticket routes')

leaves_block = """router.get('/leaves', async (req, res, next) => {
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

router.post('/leaves', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const input = leaveSchema.parse(req.body);
    if (input.endDate < input.startDate) return res.status(400).json({ message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' });
    const context = req.mosqueRole || await getModuleRole(req);
    if (context.role === 'personnel' && (!context.siteId || input.siteId !== context.siteId)) return res.status(403).json({ message: 'الموقع غير مرتبط بحسابك' });
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, context);
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
});"""
replace_block("router.get('/leaves'", "router.get('/jobs'", leaves_block, 'leave routes')

# Replace personnel through reporting section with scoped personnel, linked account creation, and safer notifications.
personnel_to_end = """router.get('/personnel', requireRoles('head', 'supervisor'), async (req, res, next) => {
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

    if (accountCreated) {
      try {
        await sendAccountActivationEmail({
          to: user.email,
          username: user.username,
          initialPassword: temporaryPassword,
          activationUrl: buildMosqueActivationUrl(activation.plainToken),
          expiresInHours: MOSQUE_ACTIVATION_TOKEN_HOURS,
          includePassword: true,
        });
      } catch (emailError) {
        await prisma.mosquePersonnel.deleteMany({ where: { userId: user.id } });
        await prisma.mosqueUserAssignment.deleteMany({ where: { userId: user.id } });
        await prisma.appUser.delete({ where: { id: user.id } });
        throw emailError;
      }
    }

    res.status(accountCreated ? 201 : 200).json({
      personnel: result.personnel,
      user: { uid: user.id, username: user.username, email: user.email, isActive: user.isActive },
      accountCreated,
      message: accountCreated
        ? 'تم إنشاء حساب منسوب المسجد وربطه بالموقع وإرسال رابط التفعيل إلى بريده الإلكتروني.'
        : 'تم ربط الحساب الموجود بالمسجد والصفة التشغيلية.',
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
});"""
replace_block("router.get('/personnel'", "export default router;", personnel_to_end, 'personnel/report routes')

path.write_text(s, encoding='utf-8')
print('Applied corrected mosque role model, privacy scopes, personnel accounts, and automatic public-token QR support')
