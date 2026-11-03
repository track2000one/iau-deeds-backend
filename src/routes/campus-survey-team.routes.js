import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

// Campus-only assignments. Adjacent private houses are outside the western campus scope.
const INITIAL_TEAM = [
  { code: 'LEAD', fullName: 'محمد المغربي', role: 'leader', campusCode: null, campusName: null },
  { code: 'WEST', fullName: 'عبدالرحمن مسفر القحطاني', role: 'member', campusCode: 'WEST', campusName: 'الحرم الغربي' },
  { code: 'RAYYAN', fullName: 'حسين علي الدبوس', role: 'member', campusCode: 'RAYYAN', campusName: 'كلية الريان' },
  { code: 'EAST', fullName: 'بدر خالد الهاجري', role: 'member', campusCode: 'EAST', campusName: 'الحرم الشرقي' },
];
const CAMPUS_NAMES = {
  WEST: ['الحرم الغربي', 'الحرم الجامعي الغربي'],
  EAST: ['الحرم الشرقي', 'الحرم الجامعي الشرقي'],
  RAYYAN: ['كلية الريان', 'الريان'],
};
const allowedStatus = z.enum(['pending', 'in_progress', 'submitted', 'returned', 'completed']);
const updateSchema = z.object({
  userId: z.string().trim().min(1).nullable().optional(),
  status: allowedStatus.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();

const isAdmin = (req) => req.authUser?.role === 'admin';
const identity = async (req) => {
  if (isAdmin(req)) return { role: 'admin' };
  const assignment = await prisma.surveyTeamAssignment.findFirst({
    where: { userId: req.authUser?.id },
  });
  return assignment ? { role: assignment.role, code: assignment.code } : null;
};
const deny = (res) => res.status(403).json({ message: 'غير مخول بالاطلاع على تكليفات الحصر' });

// Visible to the current account regardless of dashboard permission.
// Used by the central registry to lock the team member to their assigned campus.
router.get('/my-assignment', async (req, res, next) => {
  try {
    if (isAdmin(req)) return res.json(null);
    const assignment = await prisma.surveyTeamAssignment.findFirst({
      where: { userId: req.authUser.id, role: 'member' },
      select: { code: true, campusName: true, campusCode: true, status: true },
    });
    res.json(assignment || null);
  } catch (err) { next(err); }
});

// Never grant access based on a person's name; an administrator must bind the actual account ID.
router.get('/', async (req, res, next) => {
  try {
    const viewer = await identity(req);
    if (!viewer) return deny(res);
    const members = await prisma.surveyTeamAssignment.findMany({
      where: viewer.role === 'member' ? { code: viewer.code } : {},
      orderBy: { code: 'asc' },
    });
    res.json({ members, viewerRole: viewer.role, canManage: viewer.role === 'admin' || viewer.role === 'leader' });
  } catch (err) { next(err); }
});

router.get('/accounts', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return deny(res);
    const accounts = await prisma.appUser.findMany({
      where: { isActive: true },
      select: { id: true, username: true, email: true },
      orderBy: { username: 'asc' },
    });
    res.json(accounts);
  } catch (err) { next(err); }
});

router.post('/setup', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return deny(res);
    await prisma.surveyTeamAssignment.createMany({ data: INITIAL_TEAM, skipDuplicates: true });
    res.json(await prisma.surveyTeamAssignment.findMany({ orderBy: { code: 'asc' } }));
  } catch (err) { next(err); }
});

router.patch('/:code', async (req, res, next) => {
  try {
    const viewer = await identity(req);
    if (!viewer || viewer.role === 'member') return deny(res);
    const code = String(req.params.code || '').toUpperCase();
    const member = await prisma.surveyTeamAssignment.findUnique({ where: { code } });
    if (!member) return res.status(404).json({ message: 'التكليف غير موجود' });
    const input = updateSchema.parse(req.body);
    if (!isAdmin(req) && Object.hasOwn(input, 'userId')) return deny(res);
    if (input.userId) {
      const user = await prisma.appUser.findUnique({ where: { id: input.userId }, select: { id: true, isActive: true } });
      if (!user?.isActive) return res.status(400).json({ message: 'الحساب المحدد غير موجود أو غير مفعل' });
      const bound = await prisma.surveyTeamAssignment.findFirst({
        where: { userId: input.userId, code: { not: code } },
      });
      if (bound) return res.status(409).json({ message: 'الحساب مرتبط بتكليف آخر بالفعل' });
    }
    const updated = await prisma.surveyTeamAssignment.update({
      where: { code },
      data: {
        ...(Object.hasOwn(input, 'userId') ? { userId: input.userId } : {}),
        ...(input.status ? {
          status: input.status,
          ...(input.status === 'in_progress' && !member.startedAt ? { startedAt: new Date() } : {}),
          ...(input.status === 'completed' ? { completedAt: new Date() } : {}),
          ...(input.status !== 'completed' ? { completedAt: null } : {}),
        } : {}),
        ...(Object.hasOwn(input, 'notes') ? { notes: input.notes } : {}),
      },
    });
    res.json(updated);
  } catch (err) {
    if (err?.name === 'ZodError') return res.status(400).json({ message: 'بيانات التكليف غير صحيحة', issues: err.issues });
    if (err?.code === 'P2002') return res.status(409).json({ message: 'الحساب مرتبط بتكليف آخر' });
    next(err);
  }
});

// Read-only detailed work report. Restricted to leader/admin or the member's own account.
router.get('/work-report/:code', async (req, res, next) => {
  try {
    const viewer = await identity(req);
    const code = String(req.params.code || '').toUpperCase();
    if (!viewer || (viewer.role === 'member' && viewer.code !== code)) return deny(res);
    const member = await prisma.surveyTeamAssignment.findUnique({ where: { code } });
    if (!member || member.role !== 'member') return res.status(404).json({ message: 'الموظف المكلف غير موجود' });
    if (!member.userId) return res.status(409).json({ message: 'يجب ربط التكليف بحساب الموظف قبل استخراج تقرير أعماله' });
    const account = await prisma.appUser.findUnique({
      where: { id: member.userId }, select: { id: true, username: true },
    });
    if (!account) return res.status(409).json({ message: 'حساب الموظف المرتبط بالتكليف غير موجود' });

    const campuses = CAMPUS_NAMES[member.campusCode] || [member.campusName];
    const [buildings, inspections, vacantResult] = await Promise.all([
      prisma.mosqueBuilding.findMany({
        where: { createdBy: account.id, campusLocation: { in: campuses } },
        select: {
          id: true, buildingNumber: true, name: true, campusLocation: true,
          floorsCount: true, createdAt: true, deed: { select: { deedNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.siteInspection.findMany({
        where: { createdBy: account.username },
        select: {
          id: true, inspectionNumber: true, title: true, siteName: true,
          siteType: true, visitDate: true, workflowStatus: true,
          observations: true, recommendedAction: true,
          building: { select: { buildingNumber: true, campusLocation: true } },
          deed: { select: { deedNumber: true } },
        },
        orderBy: { visitDate: 'desc' },
      }),
      prisma.vacantLand.findMany({
        where: { createdById: account.id, campus: { in: campuses } },
        select: {
          id: true, code: true, name: true, campus: true, status: true,
          approximateArea: true, createdAt: true, notes: true,
          deed: { select: { deedNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
      }).then((rows) => ({ rows, available: true })).catch((err) => {
        if (err?.code === 'P2021') return { rows: [], available: false };
        throw err;
      }),
    ]);
    const activities = [
      ...buildings.map((b) => ({
        type: 'building', identifier: b.buildingNumber, title: b.name || 'مبنى',
        location: b.campusLocation || '', date: b.createdAt,
        deedNumber: b.deed?.deedNumber || null,
        details: b.floorsCount == null ? '' : 'عدد الأدوار: ' + b.floorsCount,
        inAssignedCampus: true,
      })),
      ...inspections.map((i) => ({
        type: 'inspection', identifier: i.inspectionNumber, title: i.title,
        location: i.siteName, date: i.visitDate,
        deedNumber: i.deed?.deedNumber || null,
        details: [i.observations, i.recommendedAction].filter(Boolean).join(' | '),
        // Inspections unlinked to a campus building require manual scope verification.
        inAssignedCampus: Boolean(i.building?.campusLocation && campuses.includes(i.building.campusLocation)),
      })),
      ...vacantResult.rows.map((l) => ({
        type: 'vacant_land', identifier: l.code, title: l.name,
        location: l.campus, date: l.createdAt,
        deedNumber: l.deed?.deedNumber || null,
        details: ['المساحة التقريبية: ' + l.approximateArea + ' م²', l.notes].filter(Boolean).join(' | '),
        inAssignedCampus: true,
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    res.json({
      memberName: member.fullName, username: account.username,
      campus: member.campusName, counts: {
        buildings: buildings.length, inspections: inspections.length,
        vacantLands: vacantResult.available ? vacantResult.rows.length : null,
      },
      vacantLandsTableAvailable: vacantResult.available, activities,
      disclaimer: 'السجلات منسوبة إلى الحساب وفق البيانات المتاحة. المعاينات غير المرتبطة بمبنى داخل الحرم تحتاج تحققًا من نطاقها، ولا تمثل هذه البيانات إثبات اكتمال الحصر.',
    });
  } catch (err) { next(err); }
});

// Reference counts are not completion percentages. Existing legacy records may have other campus spellings.
router.get('/metrics', async (req, res, next) => {
  try {
    const viewer = await identity(req);
    if (!viewer) return deny(res);
    const members = await prisma.surveyTeamAssignment.findMany({
      where: viewer.role === 'member' ? { code: viewer.code } : { role: 'member' },
    });
    const metrics = await Promise.all(members.filter((m) => m.campusCode).map(async (member) => {
      const names = CAMPUS_NAMES[member.campusCode] || [member.campusName];
      const buildingWhere = { campusLocation: { in: names } };
      const [buildings, inspections, vacantLands] = await Promise.all([
        prisma.mosqueBuilding.count({ where: buildingWhere }),
        prisma.siteInspection.count({ where: { building: buildingWhere } }),
        prisma.vacantLand.count({ where: { campus: { in: names } } }).catch((error) => {
          if (error?.code === 'P2021') return null; // Table not created yet: no effect on other records.
          throw error;
        }),
      ]);
      // Author-attributed counts are distinct from campus-wide existing-record totals.
      // Buildings and vacant lands use account IDs, whereas legacy inspections store username.
      const account = member.userId ? await prisma.appUser.findUnique({
        where: { id: member.userId }, select: { username: true },
      }) : null;
      const [employeeBuildings, employeeInspections, employeeVacantLands] = member.userId && account
        ? await Promise.all([
          prisma.mosqueBuilding.count({ where: { ...buildingWhere, createdBy: member.userId } }),
          prisma.siteInspection.count({ where: { createdBy: account.username } }),
          prisma.vacantLand.count({
            where: { campus: { in: names }, createdById: member.userId },
          }).catch((error) => {
            if (error?.code === 'P2021') return null;
            throw error;
          }),
        ])
        : [null, null, null];
      return {
        code: member.code, buildings, inspections, vacantLands,
        employeeBuildings, employeeInspections, employeeVacantLands,
        accountUsername: account?.username || null,
        countsAreProvisional: true,
      };
    }));
    res.json(metrics);
  } catch (err) { next(err); }
});

export default router;
