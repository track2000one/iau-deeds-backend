import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { prisma } from '../prisma.js';
import {
  createOrganizationUnit,
  getOrganizationUnit,
  getUserOrganizationAssignment,
  listOrganizationUnits,
  listUserOrganizationAssignments,
  removeUserOrganizationAssignment,
  updateOrganizationUnit,
  upsertUserOrganizationAssignment,
} from '../services/organization.service.js';

const router = Router();

const unitTypeSchema = z.enum([
  'assets_unit',
  'procurement',
  'warehouses',
  'inventory_control',
  'equipment',
  'ict',
  'beneficiary',
]);

const permissionScopeSchema = z.enum([
  'personal',
  'department',
  'sector',
  'university',
]);

const organizationSchema = z.object({
  code: z.string().trim().min(2).max(20),
  nameAr: z.string().trim().min(2).max(200),
  nameEn: z.string().trim().max(200).nullable().optional(),
  unitType: unitTypeSchema,
  parentId: z.string().trim().nullable().optional(),
  isBeneficiary: z.boolean().default(false),
  isActive: z.boolean().default(true),
  responsibility: z.string().trim().max(1000).nullable().optional(),
});

const assignmentSchema = z.object({
  organizationUnitId: z.string().trim().min(1),
  organizationRole: z.string().trim().min(1).max(120),
  permissionScope: permissionScopeSchema.default('department'),
});

router.get('/', async (_req, res, next) => {
  try {
    res.json(await listOrganizationUnits());
  } catch (error) {
    next(error);
  }
});

router.get('/assignments/all', requireAdmin, async (_req, res, next) => {
  try {
    const assignments = await listUserOrganizationAssignments();
    res.json(
      Array.from(assignments.entries()).map(([userId, assignment]) => ({
        userId,
        ...assignment,
      }))
    );
  } catch (error) {
    next(error);
  }
});

router.get('/assignments/:userId', requireAdmin, async (req, res, next) => {
  try {
    const assignment = await getUserOrganizationAssignment(req.params.userId);
    res.json({
      userId: req.params.userId,
      ...(assignment || {
        organizationUnitId: null,
        organizationRole: null,
        permissionScope: 'department',
        organizationUnit: null,
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.put('/assignments/:userId', requireAdmin, async (req, res, next) => {
  try {
    const input = assignmentSchema.parse(req.body);
    const user = await prisma.appUser.findUnique({
      where: { id: req.params.userId },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    const unit = await getOrganizationUnit(input.organizationUnitId);
    if (!unit || !unit.isActive) {
      return res.status(400).json({
        message: 'الجهة المحددة غير موجودة أو غير مفعلة',
      });
    }

    const assignment = await upsertUserOrganizationAssignment(
      req.params.userId,
      input
    );

    res.json({ userId: req.params.userId, ...assignment });
  } catch (error) {
    next(error);
  }
});

router.delete('/assignments/:userId', requireAdmin, async (req, res, next) => {
  try {
    await removeUserOrganizationAssignment(req.params.userId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const unit = await getOrganizationUnit(req.params.id);

    if (!unit) {
      return res.status(404).json({ message: 'الجهة غير موجودة' });
    }

    res.json(unit);
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const input = organizationSchema.parse(req.body);
    const unit = await createOrganizationUnit(input);
    res.status(201).json(unit);
  } catch (error) {
    if (String(error?.message || '').includes('organization_units_code_key')) {
      return res.status(409).json({ message: 'رمز الجهة مستخدم مسبقًا' });
    }
    next(error);
  }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const current = await getOrganizationUnit(req.params.id);

    if (!current) {
      return res.status(404).json({ message: 'الجهة غير موجودة' });
    }

    const input = organizationSchema.parse(req.body);

    if (input.parentId === req.params.id) {
      return res.status(400).json({
        message: 'لا يمكن أن تكون الجهة تابعة لنفسها',
      });
    }

    const unit = await updateOrganizationUnit(req.params.id, input);
    res.json(unit);
  } catch (error) {
    if (String(error?.message || '').includes('organization_units_code_key')) {
      return res.status(409).json({ message: 'رمز الجهة مستخدم مسبقًا' });
    }
    next(error);
  }
});

export default router;
