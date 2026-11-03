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
