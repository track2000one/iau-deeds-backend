import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const statusSchema = z.enum([
  'IDENTIFIED',
  'UNDER_STUDY',
  'PENDING_APPROVAL',
  'APPROVED',
  'OFFERED',
  'NEGOTIATION',
  'INVESTED',
  'REJECTED',
  'CANCELLED',
]);

const createSchema = z.object({
  areaId: z.string().min(1, 'المساحة الاستثمارية مطلوبة'),
  title: z.string().trim().min(3, 'اسم الفرصة مطلوب').max(250),
  investmentUse: z.string().trim().max(500).optional().nullable(),
  projectDescription: z.string().trim().max(5000).optional().nullable(),
  allocatedArea: z.coerce.number().positive().optional().nullable(),
  durationMonths: z.coerce.number().int().positive().max(1200).optional().nullable(),
  estimatedValue: z.coerce.number().nonnegative().optional().nullable(),
  currency: z.string().trim().min(3).max(8).default('SAR'),
  notes: z.string().trim().max(5000).optional().nullable(),
});

const updateSchema = createSchema.omit({ areaId: true }).partial();

const transitionSchema = z.object({
  toStatus: statusSchema,
  note: z.string().trim().max(3000).optional().nullable(),
});

const listSchema = z.object({
  status: statusSchema.optional(),
  areaId: z.string().optional(),
  siteId: z.string().optional(),
  search: z.string().trim().max(180).optional(),
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const includeOpportunity = {
  area: {
    include: {
      site: {
        include: {
          deed: true,
          deedLinks: {
            include: { deed: true },
          },
        },
      },
    },
  },
  events: {
    orderBy: { createdAt: 'desc' },
  },
};

const allowedTransitions = {
  IDENTIFIED: ['UNDER_STUDY', 'CANCELLED'],
  UNDER_STUDY: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'UNDER_STUDY', 'CANCELLED'],
  APPROVED: ['OFFERED', 'CANCELLED'],
  OFFERED: ['NEGOTIATION', 'CANCELLED'],
  NEGOTIATION: ['INVESTED', 'OFFERED', 'CANCELLED'],
  REJECTED: ['UNDER_STUDY', 'CANCELLED'],
  INVESTED: [],
  CANCELLED: [],
};

const hasText = (value) => String(value || '').trim().length > 0;

const hasPolygon = (value) => {
  if (!value || typeof value !== 'object') return false;

  const geometry =
    value.type === 'Feature' && value.geometry
      ? value.geometry
      : value;

  return (
    geometry?.type === 'Polygon' &&
    Array.isArray(geometry?.coordinates?.[0]) &&
    geometry.coordinates[0].length >= 4
  );
};

const getDeedCount = (site) => {
  const ids = new Set(
    (site?.deedLinks || []).map((link) => link.deedId)
  );

  if (site?.deedId) ids.add(site.deedId);
  return ids.size;
};

const getAreaGateBlockers = (area) => {
  const site = area?.site;
  const blockers = [];

  if (getDeedCount(site) === 0) blockers.push('MISSING_DEED');
  if (!hasPolygon(site?.geoJson)) blockers.push('MISSING_SITE_BOUNDARY');
  if (site?.geometryApprovalStatus !== 'APPROVED') {
    blockers.push('SITE_BOUNDARY_NOT_APPROVED');
  }

  if (area?.occupancyStatus !== 'AVAILABLE') blockers.push('AREA_NOT_AVAILABLE');
  if (area?.investmentReadiness !== 'READY') blockers.push('READINESS_NOT_READY');
  if (!hasPolygon(area?.geoJson)) blockers.push('MISSING_AREA_BOUNDARY');
  if (area?.geometryApprovalStatus !== 'APPROVED') {
    blockers.push('AREA_BOUNDARY_NOT_APPROVED');
  }

  if (!(Number(area?.surveyedArea || 0) > 0)) {
    blockers.push('MISSING_SURVEYED_AREA');
  }

  if (!hasText(area?.proposedUse)) blockers.push('MISSING_PROPOSED_USE');

  return blockers;
};

const blockerLabels = {
  MISSING_DEED: 'ربط الموقع الرئيسي بصك',
  MISSING_SITE_BOUNDARY: 'إضافة حدود الموقع الرئيسي',
  SITE_BOUNDARY_NOT_APPROVED: 'اعتماد حدود الموقع الرئيسي',
  AREA_NOT_AVAILABLE: 'تغيير حالة المساحة إلى متاحة',
  READINESS_NOT_READY: 'استكمال جاهزية الاستثمار',
  MISSING_AREA_BOUNDARY: 'إضافة حدود المساحة',
  AREA_BOUNDARY_NOT_APPROVED: 'اعتماد حدود المساحة',
  MISSING_SURVEYED_AREA: 'إدخال المساحة المساحية المعتمدة',
  MISSING_PROPOSED_USE: 'تحديد الاستخدام المقترح',
};

const generateOpportunityNumber = () => {
  const year = new Date().getFullYear();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  return `OPP-${year}-${suffix}`;
};

const userSnapshot = (req) => ({
  id: req.authUser?.id || null,
  name:
    req.authUser?.username ||
    req.authUser?.email ||
    null,
});

const validateAllocatedArea = (area, allocatedArea) => {
  if (allocatedArea == null) return;

  const referenceArea =
    Number(area?.surveyedArea || 0) ||
    Number(area?.approximateArea || 0);

  if (referenceArea > 0 && Number(allocatedArea) > referenceArea) {
    const error = new Error(
      `المساحة المخصصة للفرصة لا يمكن أن تتجاوز مساحة السجل المرجعية (${referenceArea.toLocaleString('ar-SA')} م²)`
    );
    error.statusCode = 400;
    throw error;
  }
};

const assertSubmissionComplete = (opportunity) => {
  const missing = [];

  if (!hasText(opportunity.investmentUse)) missing.push('الاستخدام الاستثماري');
  if (!hasText(opportunity.projectDescription)) missing.push('وصف المشروع');
  if (!(Number(opportunity.allocatedArea || 0) > 0)) missing.push('المساحة المخصصة');
  if (!(Number(opportunity.durationMonths || 0) > 0)) missing.push('مدة الاستثمار');
  if (!(Number(opportunity.estimatedValue || 0) > 0)) missing.push('القيمة التقديرية');

  if (missing.length > 0) {
    const error = new Error(
      `لا يمكن الإحالة للموافقة قبل استكمال: ${missing.join('، ')}`
    );
    error.statusCode = 400;
    throw error;
  }
};

router.get('/eligible-areas', async (_req, res, next) => {
  try {
    const areas = await prisma.investmentArea.findMany({
      where: { isActive: true },
      include: {
        site: {
          include: {
            deed: true,
            deedLinks: {
              include: { deed: true },
            },
          },
        },
        opportunities: {
          where: {
            isActive: true,
            status: {
              notIn: ['REJECTED', 'CANCELLED'],
            },
          },
          select: {
            id: true,
            opportunityNumber: true,
            status: true,
          },
        },
      },
      orderBy: [
        { site: { name: 'asc' } },
        { areaNumber: 'asc' },
      ],
    });

    const items = areas.map((area) => {
      const blockers = getAreaGateBlockers(area);
      const activeOpportunity = area.opportunities[0] || null;

      if (activeOpportunity) blockers.push('ACTIVE_OPPORTUNITY_EXISTS');

      return {
        id: area.id,
        areaCode: area.areaCode,
        name: area.name,
        surveyedArea: area.surveyedArea,
        approximateArea: area.approximateArea,
        proposedUse: area.proposedUse,
        site: {
          id: area.site.id,
          code: area.site.code,
          name: area.site.name,
        },
        eligible: blockers.length === 0,
        blockers,
        activeOpportunity,
      };
    });

    res.json({
      items,
      eligibleCount: items.filter((item) => item.eligible).length,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const query = listSchema.parse(req.query);
    const where = {
      isActive:
        query.active === undefined
          ? true
          : query.active === 'true',
    };

    if (query.status) where.status = query.status;
    if (query.areaId) where.areaId = query.areaId;
    if (query.siteId) where.area = { siteId: query.siteId };

    if (query.search) {
      const searchFilter = {
        OR: [
          { opportunityNumber: { contains: query.search, mode: 'insensitive' } },
          { title: { contains: query.search, mode: 'insensitive' } },
          { investmentUse: { contains: query.search, mode: 'insensitive' } },
          { area: { areaCode: { contains: query.search, mode: 'insensitive' } } },
          { area: { site: { name: { contains: query.search, mode: 'insensitive' } } } },
        ],
      };

      if (where.area) {
        where.AND = [
          { area: where.area },
          searchFilter,
        ];
        delete where.area;
      } else {
        Object.assign(where, searchFilter);
      }
    }

    const skip = (query.page - 1) * query.limit;
    const [items, total, allActive] = await Promise.all([
      prisma.investmentOpportunity.findMany({
        where,
        include: {
          area: {
            include: {
              site: true,
            },
          },
          _count: {
            select: { events: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: query.limit,
      }),
      prisma.investmentOpportunity.count({ where }),
      prisma.investmentOpportunity.findMany({
        where: { isActive: true },
        select: {
          status: true,
          estimatedValue: true,
          allocatedArea: true,
        },
      }),
    ]);

    const stats = {
      total: allActive.length,
      identified: 0,
      underStudy: 0,
      pendingApproval: 0,
      approved: 0,
      offered: 0,
      negotiation: 0,
      invested: 0,
      rejected: 0,
      cancelled: 0,
      totalEstimatedValue: 0,
      investedEstimatedValue: 0,
      allocatedArea: 0,
    };

    const statusKey = {
      IDENTIFIED: 'identified',
      UNDER_STUDY: 'underStudy',
      PENDING_APPROVAL: 'pendingApproval',
      APPROVED: 'approved',
      OFFERED: 'offered',
      NEGOTIATION: 'negotiation',
      INVESTED: 'invested',
      REJECTED: 'rejected',
      CANCELLED: 'cancelled',
    };

    for (const item of allActive) {
      stats[statusKey[item.status]] += 1;
      stats.totalEstimatedValue += Number(item.estimatedValue || 0);
      stats.allocatedArea += Number(item.allocatedArea || 0);

      if (item.status === 'INVESTED') {
        stats.investedEstimatedValue += Number(item.estimatedValue || 0);
      }
    }

    res.json({
      items,
      stats,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.max(1, Math.ceil(total / query.limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const opportunity = await prisma.investmentOpportunity.findUnique({
      where: { id: req.params.id },
      include: includeOpportunity,
    });

    if (!opportunity) {
      return res.status(404).json({ message: 'الفرصة الاستثمارية غير موجودة' });
    }

    res.json(opportunity);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);

    const area = await prisma.investmentArea.findUnique({
      where: { id: input.areaId },
      include: {
        site: {
          include: {
            deed: true,
            deedLinks: {
              include: { deed: true },
            },
          },
        },
        opportunities: {
          where: {
            isActive: true,
            status: {
              notIn: ['REJECTED', 'CANCELLED'],
            },
          },
          select: {
            id: true,
            opportunityNumber: true,
            status: true,
          },
        },
      },
    });

    if (!area || !area.isActive || !area.site?.isActive) {
      return res.status(400).json({
        message: 'المساحة الاستثمارية أو موقعها الرئيسي غير متاح',
      });
    }

    const blockers = getAreaGateBlockers(area);
    if (blockers.length > 0) {
      return res.status(409).json({
        message:
          'لا يمكن إنشاء فرصة فعلية قبل استكمال بوابة الجاهزية التشغيلية للمساحة',
        blockers: blockers.map((code) => ({
          code,
          label: blockerLabels[code] || code,
        })),
      });
    }

    if (area.opportunities.length > 0) {
      return res.status(409).json({
        message:
          `يوجد بالفعل فرصة نشطة لهذه المساحة: ${area.opportunities[0].opportunityNumber}`,
      });
    }

    validateAllocatedArea(area, input.allocatedArea);

    const actor = userSnapshot(req);
    const opportunityNumber = generateOpportunityNumber();

    const created = await prisma.$transaction(async (tx) => {
      const opportunity = await tx.investmentOpportunity.create({
        data: {
          opportunityNumber,
          areaId: input.areaId,
          title: input.title,
          investmentUse: input.investmentUse,
          projectDescription: input.projectDescription,
          allocatedArea: input.allocatedArea,
          durationMonths: input.durationMonths,
          estimatedValue: input.estimatedValue,
          currency: input.currency,
          notes: input.notes,
          createdById: actor.id,
          createdByName: actor.name,
        },
      });

      await tx.investmentOpportunityEvent.create({
        data: {
          opportunityId: opportunity.id,
          fromStatus: null,
          toStatus: 'IDENTIFIED',
          action: 'CREATED',
          note: 'تم إنشاء الفرصة من مساحة استثمارية مستوفية لبوابة الجاهزية التشغيلية.',
          changedById: actor.id,
          changedByName: actor.name,
        },
      });

      return opportunity;
    });

    const opportunity = await prisma.investmentOpportunity.findUnique({
      where: { id: created.id },
      include: includeOpportunity,
    });

    res.status(201).json(opportunity);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = updateSchema.parse(req.body);

    const existing = await prisma.investmentOpportunity.findUnique({
      where: { id: req.params.id },
      include: { area: true },
    });

    if (!existing || !existing.isActive) {
      return res.status(404).json({ message: 'الفرصة الاستثمارية غير موجودة' });
    }

    if (!['IDENTIFIED', 'UNDER_STUDY', 'REJECTED'].includes(existing.status)) {
      return res.status(409).json({
        message:
          'بيانات الفرصة مقفلة في الحالة الحالية. أعد الفرصة إلى «تحت الدراسة» قبل تعديل البيانات، متى كان هذا الانتقال متاحًا.',
      });
    }

    validateAllocatedArea(
      existing.area,
      Object.prototype.hasOwnProperty.call(input, 'allocatedArea')
        ? input.allocatedArea
        : existing.allocatedArea
    );

    const actor = userSnapshot(req);

    await prisma.$transaction(async (tx) => {
      await tx.investmentOpportunity.update({
        where: { id: existing.id },
        data: input,
      });

      await tx.investmentOpportunityEvent.create({
        data: {
          opportunityId: existing.id,
          fromStatus: existing.status,
          toStatus: existing.status,
          action: 'UPDATED',
          note: 'تم تحديث بيانات الفرصة الاستثمارية.',
          changedById: actor.id,
          changedByName: actor.name,
        },
      });
    });

    const updated = await prisma.investmentOpportunity.findUnique({
      where: { id: existing.id },
      include: includeOpportunity,
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const input = transitionSchema.parse(req.body);

    const existing = await prisma.investmentOpportunity.findUnique({
      where: { id: req.params.id },
      include: includeOpportunity,
    });

    if (!existing || !existing.isActive) {
      return res.status(404).json({ message: 'الفرصة الاستثمارية غير موجودة' });
    }

    const allowed = allowedTransitions[existing.status] || [];
    if (!allowed.includes(input.toStatus)) {
      return res.status(409).json({
        message:
          `الانتقال من ${existing.status} إلى ${input.toStatus} غير مسموح`,
        allowedTransitions: allowed,
      });
    }

    if (
      ['APPROVED', 'REJECTED'].includes(input.toStatus) &&
      req.authUser?.role !== 'admin'
    ) {
      return res.status(403).json({
        message: 'اعتماد الفرصة أو رفضها متاح للمسؤول فقط',
      });
    }

    if (input.toStatus === 'PENDING_APPROVAL') {
      assertSubmissionComplete(existing);
    }

    if (
      ['REJECTED', 'CANCELLED'].includes(input.toStatus) &&
      !hasText(input.note)
    ) {
      return res.status(400).json({
        message: 'سبب الرفض أو الإلغاء مطلوب',
      });
    }

    const actor = userSnapshot(req);
    const now = new Date();
    const timestampData = {
      statusChangedAt: now,
    };

    if (input.toStatus === 'PENDING_APPROVAL') {
      timestampData.submittedAt = now;
    }

    if (input.toStatus === 'APPROVED') {
      timestampData.approvedAt = now;
      timestampData.approvedById = actor.id;
      timestampData.approvedByName = actor.name;
    }

    if (input.toStatus === 'OFFERED') {
      timestampData.offeredAt = now;
    }

    if (input.toStatus === 'INVESTED') {
      timestampData.investedAt = now;
    }

    if (input.toStatus === 'CANCELLED') {
      timestampData.cancelledAt = now;
    }

    await prisma.$transaction(async (tx) => {
      await tx.investmentOpportunity.update({
        where: { id: existing.id },
        data: {
          status: input.toStatus,
          ...timestampData,
        },
      });

      await tx.investmentOpportunityEvent.create({
        data: {
          opportunityId: existing.id,
          fromStatus: existing.status,
          toStatus: input.toStatus,
          action: 'STATUS_CHANGED',
          note: input.note,
          changedById: actor.id,
          changedByName: actor.name,
        },
      });
    });

    const updated = await prisma.investmentOpportunity.findUnique({
      where: { id: existing.id },
      include: includeOpportunity,
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.investmentOpportunity.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      return res.status(404).json({ message: 'الفرصة الاستثمارية غير موجودة' });
    }

    if (!['IDENTIFIED', 'REJECTED', 'CANCELLED'].includes(existing.status)) {
      return res.status(409).json({
        message:
          'لا يمكن أرشفة فرصة نشطة في مرحلة إجرائية متقدمة. ألغِ الفرصة أولًا.',
      });
    }

    await prisma.investmentOpportunity.update({
      where: { id: existing.id },
      data: { isActive: false },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
