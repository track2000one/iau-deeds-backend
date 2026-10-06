import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const areaStatusSchema = z.enum([
  'AVAILABLE',
  'OCCUPIED',
  'PARTIALLY_OCCUPIED',
  'RESERVED',
  'ALLOCATED',
  'UNAVAILABLE',
]);

const readinessSchema = z.enum([
  'NOT_ASSESSED',
  'UNDER_REVIEW',
  'READY',
  'NOT_SUITABLE',
]);

const accuracySchema = z.enum([
  'APPROXIMATE',
  'FIELD_VERIFIED',
  'SURVEYED',
  'OFFICIAL',
]);

const createAreaSchema = z.object({
  siteId: z.string().min(1, 'الموقع الرئيسي مطلوب'),
  areaNumber: z.coerce.number().int().positive('رقم الموقع يجب أن يكون أكبر من صفر'),
  areaCode: z.string().trim().min(2).max(50)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().max(250).optional().nullable(),
  description: z.string().trim().max(3000).optional().nullable(),
  approximateArea: z.coerce.number().positive().optional().nullable(),
  surveyedArea: z.coerce.number().positive().optional().nullable(),
  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  geoJson: z.unknown().optional().nullable(),
  geometryAccuracy: accuracySchema.default('APPROXIMATE'),
  occupancyStatus: areaStatusSchema.default('AVAILABLE'),
  investmentReadiness: readinessSchema.default('NOT_ASSESSED'),
  currentUse: z.string().trim().max(500).optional().nullable(),
  proposedUse: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const updateAreaSchema = createAreaSchema.partial();

const bulkImportSchema = z.object({
  siteId: z.string().min(1, 'الموقع الرئيسي مطلوب'),
  areas: z.array(
    createAreaSchema.omit({ siteId: true })
  ).min(1).max(200),
});

const listSchema = z.object({
  siteId: z.string().optional(),
  status: areaStatusSchema.optional(),
  readiness: readinessSchema.optional(),
  search: z.string().trim().optional(),
  active: z.enum(['true', 'false']).optional(),
  minArea: z.coerce.number().min(0).optional(),
  maxArea: z.coerce.number().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

router.get('/', async (req, res, next) => {
  try {
    const query = listSchema.parse(req.query);
    const where = {
      isActive: query.active === undefined ? true : query.active === 'true',
    };

    if (query.siteId) where.siteId = query.siteId;
    if (query.status) where.occupancyStatus = query.status;
    if (query.readiness) where.investmentReadiness = query.readiness;

    if (query.minArea !== undefined || query.maxArea !== undefined) {
      where.approximateArea = {};
      if (query.minArea !== undefined) where.approximateArea.gte = query.minArea;
      if (query.maxArea !== undefined) where.approximateArea.lte = query.maxArea;
    }

    if (query.search) {
      where.OR = [
        { areaCode: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { site: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const skip = (query.page - 1) * query.limit;
    const [items, total] = await Promise.all([
      prisma.investmentArea.findMany({
        where,
        include: {
          site: {
            include: {
              deed: {
                select: {
                  id: true,
                  deedNumber: true,
                  propertyDescription: true,
                },
              },
            },
          },
        },
        orderBy: [{ site: { name: 'asc' } }, { areaNumber: 'asc' }],
        skip,
        take: query.limit,
      }),
      prisma.investmentArea.count({ where }),
    ]);

    res.json({
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const area = await prisma.investmentArea.findUnique({
      where: { id: req.params.id },
      include: { site: { include: { deed: true } } },
    });

    if (!area) {
      return res.status(404).json({ message: 'المساحة غير موجودة' });
    }

    res.json(area);
  } catch (error) {
    next(error);
  }
});

router.post('/bulk', async (req, res, next) => {
  try {
    const input = bulkImportSchema.parse(req.body);

    const site = await prisma.investmentSite.findUnique({
      where: { id: input.siteId },
    });

    if (!site || !site.isActive) {
      return res.status(400).json({
        message: 'الموقع الرئيسي غير موجود أو غير نشط',
      });
    }

    const normalized = input.areas.map((area) => ({
      ...area,
      siteId: input.siteId,
      areaCode: String(area.areaCode || '').trim().toUpperCase(),
      createdBy: req.authUser?.id || null,
    }));

    const areaNumbers = normalized.map((area) => area.areaNumber);
    const areaCodes = normalized.map((area) => area.areaCode);

    if (new Set(areaNumbers).size !== areaNumbers.length) {
      return res.status(400).json({
        message: 'ملف الاستيراد يحتوي على أرقام مواقع مكررة داخل نفس الموقع الرئيسي',
      });
    }

    if (new Set(areaCodes).size !== areaCodes.length) {
      return res.status(400).json({
        message: 'ملف الاستيراد يحتوي على رموز مساحات مكررة',
      });
    }

    const invalidCode = normalized.find(
      (area) => !area.areaCode.startsWith(`${site.code.toUpperCase()}-`)
    );

    if (invalidCode) {
      return res.status(400).json({
        message: `رمز المساحة ${invalidCode.areaCode} لا يتوافق مع رمز الموقع الرئيسي ${site.code}`,
      });
    }

    const existing = await prisma.investmentArea.findMany({
      where: {
        OR: [
          {
            siteId: input.siteId,
            areaNumber: { in: areaNumbers },
          },
          {
            areaCode: { in: areaCodes },
          },
        ],
      },
      select: {
        areaNumber: true,
        areaCode: true,
        isActive: true,
      },
    });

    const existingNumbers = new Set(existing.map((item) => item.areaNumber));
    const existingCodes = new Set(existing.map((item) => item.areaCode));

    const pending = normalized.filter(
      (area) =>
        !existingNumbers.has(area.areaNumber) &&
        !existingCodes.has(area.areaCode)
    );

    if (pending.length > 0) {
      await prisma.investmentArea.createMany({
        data: pending,
        skipDuplicates: true,
      });
    }

    const items = await prisma.investmentArea.findMany({
      where: {
        siteId: input.siteId,
        areaNumber: { in: areaNumbers },
      },
      orderBy: { areaNumber: 'asc' },
    });

    res.status(201).json({
      siteId: input.siteId,
      requested: normalized.length,
      created: pending.length,
      skipped: normalized.length - pending.length,
      items,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = createAreaSchema.parse(req.body);

    const site = await prisma.investmentSite.findUnique({
      where: { id: input.siteId },
    });

    if (!site || !site.isActive) {
      return res.status(400).json({
        message: 'الموقع الرئيسي غير موجود أو غير نشط',
      });
    }

    const duplicateNumber = await prisma.investmentArea.findFirst({
      where: {
        siteId: input.siteId,
        areaNumber: input.areaNumber,
      },
    });

    if (duplicateNumber) {
      return res.status(409).json({
        message: 'رقم الموقع مستخدم مسبقًا داخل هذا الموقع الرئيسي',
      });
    }

    const duplicateCode = await prisma.investmentArea.findUnique({
      where: { areaCode: input.areaCode },
    });

    if (duplicateCode) {
      return res.status(409).json({ message: 'رمز المساحة مستخدم مسبقًا' });
    }

    const area = await prisma.investmentArea.create({
      data: {
        ...input,
        createdBy: req.authUser?.id || null,
      },
      include: { site: { include: { deed: true } } },
    });

    res.status(201).json(area);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = updateAreaSchema.parse(req.body);
    const existing = await prisma.investmentArea.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      return res.status(404).json({ message: 'المساحة غير موجودة' });
    }

    const targetSiteId = input.siteId || existing.siteId;
    const targetNumber = input.areaNumber ?? existing.areaNumber;

    const targetSite = await prisma.investmentSite.findUnique({
      where: { id: targetSiteId },
    });
    if (!targetSite || !targetSite.isActive) {
      return res.status(400).json({
        message: 'الموقع الرئيسي غير موجود أو غير نشط',
      });
    }

    const duplicateNumber = await prisma.investmentArea.findFirst({
      where: {
        siteId: targetSiteId,
        areaNumber: targetNumber,
        id: { not: existing.id },
      },
    });

    if (duplicateNumber) {
      return res.status(409).json({
        message: 'رقم الموقع مستخدم مسبقًا داخل هذا الموقع الرئيسي',
      });
    }

    if (input.areaCode && input.areaCode !== existing.areaCode) {
      const duplicateCode = await prisma.investmentArea.findUnique({
        where: { areaCode: input.areaCode },
      });
      if (duplicateCode) {
        return res.status(409).json({ message: 'رمز المساحة مستخدم مسبقًا' });
      }
    }

    const area = await prisma.investmentArea.update({
      where: { id: req.params.id },
      data: input,
      include: { site: { include: { deed: true } } },
    });

    res.json(area);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.investmentArea.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      return res.status(404).json({ message: 'المساحة غير موجودة' });
    }

    await prisma.investmentArea.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
