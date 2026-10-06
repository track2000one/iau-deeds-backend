import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const nullableText = (max = 2000) =>
  z.string().trim().max(max).optional().nullable();

const latitudeSchema = z.coerce.number().min(-90).max(90).optional().nullable();
const longitudeSchema = z.coerce.number().min(-180).max(180).optional().nullable();

const createSiteSchema = z.object({
  code: z.string().trim().min(2, 'رمز الموقع مطلوب').max(30)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(2, 'اسم الموقع مطلوب').max(250),
  description: nullableText(3000),
  deedId: z.string().trim().optional().nullable(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  region: z.string().trim().max(120).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  district: z.string().trim().max(120).optional().nullable(),
});

const updateSiteSchema = createSiteSchema.partial();

const listSchema = z.object({
  search: z.string().trim().optional(),
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

router.get('/', async (req, res, next) => {
  try {
    const query = listSchema.parse(req.query);
    const where = {
      isActive: query.active === undefined ? true : query.active === 'true',
    };

    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { city: { contains: query.search, mode: 'insensitive' } },
        { district: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const skip = (query.page - 1) * query.limit;
    const [items, total] = await Promise.all([
      prisma.investmentSite.findMany({
        where,
        include: {
          deed: {
            select: {
              id: true,
              deedNumber: true,
              propertyDescription: true,
              area: true,
              city: true,
              district: true,
              region: true,
            },
          },
          _count: {
            select: {
              areas: { where: { isActive: true } },
            },
          },
        },
        orderBy: { name: 'asc' },
        skip,
        take: query.limit,
      }),
      prisma.investmentSite.count({ where }),
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
    const site = await prisma.investmentSite.findUnique({
      where: { id: req.params.id },
      include: {
        deed: true,
        areas: {
          where: { isActive: true },
          orderBy: { areaNumber: 'asc' },
        },
      },
    });

    if (!site) {
      return res.status(404).json({ message: 'الموقع غير موجود' });
    }

    res.json(site);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = createSiteSchema.parse(req.body);

    const existing = await prisma.investmentSite.findUnique({
      where: { code: input.code },
    });

    if (existing) {
      return res.status(409).json({ message: 'رمز الموقع مستخدم مسبقًا' });
    }

    if (input.deedId) {
      const deed = await prisma.deed.findUnique({ where: { id: input.deedId } });
      if (!deed) {
        return res.status(400).json({ message: 'الصك المرتبط غير موجود' });
      }
    }

    const site = await prisma.investmentSite.create({
      data: {
        ...input,
        latitude: input.latitude == null ? null : input.latitude,
        longitude: input.longitude == null ? null : input.longitude,
        createdBy: req.authUser?.id || null,
      },
      include: { deed: true },
    });

    res.status(201).json(site);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = updateSiteSchema.parse(req.body);
    const existing = await prisma.investmentSite.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      return res.status(404).json({ message: 'الموقع غير موجود' });
    }

    if (input.code && input.code !== existing.code) {
      const duplicate = await prisma.investmentSite.findUnique({
        where: { code: input.code },
      });
      if (duplicate) {
        return res.status(409).json({ message: 'رمز الموقع مستخدم مسبقًا' });
      }
    }

    if (input.deedId) {
      const deed = await prisma.deed.findUnique({ where: { id: input.deedId } });
      if (!deed) {
        return res.status(400).json({ message: 'الصك المرتبط غير موجود' });
      }
    }

    const site = await prisma.investmentSite.update({
      where: { id: req.params.id },
      data: input,
      include: { deed: true },
    });

    res.json(site);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const site = await prisma.investmentSite.findUnique({
      where: { id: req.params.id },
      include: {
        _count: {
          select: {
            areas: { where: { isActive: true } },
          },
        },
      },
    });

    if (!site) {
      return res.status(404).json({ message: 'الموقع غير موجود' });
    }

    if (site._count.areas > 0) {
      return res.status(409).json({
        message: 'لا يمكن أرشفة الموقع لوجود مساحات نشطة مرتبطة به',
      });
    }

    await prisma.investmentSite.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
