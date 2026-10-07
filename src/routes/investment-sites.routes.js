import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const nullableText = (max = 2000) =>
  z.string().trim().max(max).optional().nullable();

const latitudeSchema = z.coerce.number().min(-90).max(90).optional().nullable();
const longitudeSchema = z.coerce.number().min(-180).max(180).optional().nullable();

const accuracySchema = z.enum([
  'APPROXIMATE',
  'FIELD_VERIFIED',
  'SURVEYED',
  'OFFICIAL',
]);

const polygonCoordinateSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

const polygonRingSchema = z
  .array(polygonCoordinateSchema)
  .min(4, 'حدود الموقع يجب أن تحتوي على ثلاث نقاط على الأقل')
  .max(2000)
  .refine(
    (ring) => {
      const first = ring[0];
      const last = ring[ring.length - 1];
      return first?.[0] === last?.[0] && first?.[1] === last?.[1];
    },
    'يجب إغلاق حدود الموقع بإعادة أول نقطة في نهاية المضلع'
  );

const polygonGeometrySchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(polygonRingSchema).min(1).max(50),
}).passthrough();

const polygonGeoJsonSchema = z.union([
  polygonGeometrySchema,
  z.object({
    type: z.literal('Feature'),
    geometry: polygonGeometrySchema,
    properties: z.record(z.unknown()).optional().nullable(),
  }).passthrough(),
]).optional().nullable();

const createSiteSchema = z.object({
  code: z.string().trim().min(2, 'رمز الموقع مطلوب').max(30)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(2, 'اسم الموقع مطلوب').max(250),
  description: nullableText(3000),
  deedId: z.string().trim().optional().nullable(),
  deedIds: z.array(z.string().trim().min(1)).max(10).optional(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  geoJson: polygonGeoJsonSchema,
  geometryAccuracy: accuracySchema.optional(),
  region: z.string().trim().max(120).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  district: z.string().trim().max(120).optional().nullable(),
});

const updateSiteSchema = createSiteSchema.partial();

const bulkSiteGeometryUpdateSchema = z.object({
  items: z.array(z.object({
    siteId: z.string().min(1),
    geoJson: polygonGeoJsonSchema,
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    geometryAccuracy: accuracySchema.optional(),
  })).min(1).max(100),
});

const listSchema = z.object({
  search: z.string().trim().optional(),
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// Investment-only staff can link a site to a deed without accessing deed documents.
const deedSummary = {
  id: true,
  deedNumber: true,
  propertyDescription: true,
  city: true,
  region: true,
  district: true,
  area: true,
};


const siteInclude = {
  deed: { select: deedSummary },
  deedLinks: {
    include: { deed: { select: deedSummary } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  },
};

const uniqueIds = (values = []) =>
  [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];

const ensureDeedsExist = async (db, deedIds) => {
  if (!deedIds.length) return;

  const existing = await db.deed.findMany({
    where: { id: { in: deedIds } },
    select: { id: true },
  });

  if (existing.length !== deedIds.length) {
    const found = new Set(existing.map((item) => item.id));
    const missing = deedIds.filter((id) => !found.has(id));

    const error = new Error(`الصكوك المرتبطة غير موجودة: ${missing.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
};

router.get('/deed-options', async (req, res, next) => {
  try {
    const query = z.object({
      search: z.string().trim().min(2).max(100),
      limit: z.coerce.number().int().min(1).max(30).default(15),
    }).parse(req.query);

    const items = await prisma.deed.findMany({
      where: {
        OR: [
          { deedNumber: { contains: query.search, mode: 'insensitive' } },
          { propertyDescription: { contains: query.search, mode: 'insensitive' } },
          { city: { contains: query.search, mode: 'insensitive' } },
        ],
      },
      select: deedSummary,
      take: query.limit,
      orderBy: { deedNumber: 'asc' },
    });

    res.json({ items });
  } catch (error) {
    next(error);
  }
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
          ...siteInclude,
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
        ...siteInclude,
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

router.post('/geometry-bulk', async (req, res, next) => {
  try {
    const input = bulkSiteGeometryUpdateSchema.parse(req.body);
    const siteIds = input.items.map((item) => item.siteId);

    if (new Set(siteIds).size !== siteIds.length) {
      return res.status(400).json({
        message: 'طلب تحديث الحدود يحتوي على الموقع الرئيسي نفسه أكثر من مرة',
      });
    }

    const existingSites = await prisma.investmentSite.findMany({
      where: {
        id: { in: siteIds },
        isActive: true,
      },
      select: {
        id: true,
        code: true,
        name: true,
        geometryAccuracy: true,
      },
    });

    if (existingSites.length !== siteIds.length) {
      const found = new Set(existingSites.map((site) => site.id));
      const missing = siteIds.filter((id) => !found.has(id));
      return res.status(400).json({
        message: `بعض المواقع غير موجودة أو مؤرشفة: ${missing.join(', ')}`,
      });
    }

    const existingById = new Map(
      existingSites.map((site) => [site.id, site])
    );

    const updated = await prisma.$transaction(async (tx) => {
      const results = [];

      for (const item of input.items) {
        const existing = existingById.get(item.siteId);

        const site = await tx.investmentSite.update({
          where: { id: item.siteId },
          data: {
            geoJson: item.geoJson,
            latitude: item.latitude,
            longitude: item.longitude,
            geometryAccuracy:
              item.geometryAccuracy || existing.geometryAccuracy,
          },
          select: {
            id: true,
            code: true,
            name: true,
            latitude: true,
            longitude: true,
            geometryAccuracy: true,
            updatedAt: true,
          },
        });

        results.push(site);
      }

      return results;
    });

    res.json({
      requested: input.items.length,
      updated: updated.length,
      items: updated,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = createSiteSchema.parse(req.body);
    const { deedIds = [], deedId = null, ...siteData } = input;

    const existing = await prisma.investmentSite.findUnique({
      where: { code: input.code },
    });

    if (existing) {
      return res.status(409).json({ message: 'رمز الموقع مستخدم مسبقًا' });
    }

    const linkedDeedIds = uniqueIds([deedId, ...deedIds]);
    await ensureDeedsExist(prisma, linkedDeedIds);

    const primaryDeedId = deedId || linkedDeedIds[0] || null;

    const site = await prisma.$transaction(async (tx) => {
      const created = await tx.investmentSite.create({
        data: {
          ...siteData,
          deedId: primaryDeedId,
          latitude: siteData.latitude == null ? null : siteData.latitude,
          longitude: siteData.longitude == null ? null : siteData.longitude,
          createdBy: req.authUser?.id || null,
        },
      });

      if (linkedDeedIds.length) {
        await tx.investmentSiteDeed.createMany({
          data: linkedDeedIds.map((linkedDeedId) => ({
            siteId: created.id,
            deedId: linkedDeedId,
            isPrimary: linkedDeedId === primaryDeedId,
          })),
          skipDuplicates: true,
        });
      }

      return tx.investmentSite.findUnique({
        where: { id: created.id },
        include: siteInclude,
      });
    });

    res.status(201).json(site);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = updateSiteSchema.parse(req.body);
    const { deedIds, deedId, ...siteData } = input;

    const existing = await prisma.investmentSite.findUnique({
      where: { id: req.params.id },
      include: { deedLinks: true },
    });

    if (!existing) {
      return res.status(404).json({ message: 'الموقع غير موجود' });
    }

    if (input.code && input.code !== existing.code) {
      const linkedAreas = await prisma.investmentArea.count({
        where: { siteId: existing.id, isActive: true },
      });
      if (linkedAreas > 0) {
        return res.status(409).json({
          message: 'لا يمكن تغيير رمز موقع له مساحات نشطة؛ حفاظًا على رموز المساحات المرتبطة به',
        });
      }

      const duplicate = await prisma.investmentSite.findUnique({
        where: { code: input.code },
      });
      if (duplicate) {
        return res.status(409).json({ message: 'رمز الموقع مستخدم مسبقًا' });
      }
    }

    const deedLinksRequested =
      Object.prototype.hasOwnProperty.call(input, 'deedIds') ||
      Object.prototype.hasOwnProperty.call(input, 'deedId');

    let linkedDeedIds = null;
    let primaryDeedId = existing.deedId;

    if (deedLinksRequested) {
      if (deedIds !== undefined) {
        linkedDeedIds = uniqueIds([deedId, ...deedIds]);
      } else if (deedId) {
        linkedDeedIds = uniqueIds([
          deedId,
          ...existing.deedLinks.map((link) => link.deedId),
        ]);
      } else {
        linkedDeedIds = [];
      }

      await ensureDeedsExist(prisma, linkedDeedIds);
      primaryDeedId = deedId || linkedDeedIds[0] || null;
    }

    const site = await prisma.$transaction(async (tx) => {
      await tx.investmentSite.update({
        where: { id: req.params.id },
        data: {
          ...siteData,
          ...(deedLinksRequested ? { deedId: primaryDeedId } : {}),
        },
      });

      if (deedLinksRequested && linkedDeedIds) {
        await tx.investmentSiteDeed.deleteMany({
          where: { siteId: req.params.id },
        });

        if (linkedDeedIds.length) {
          await tx.investmentSiteDeed.createMany({
            data: linkedDeedIds.map((linkedDeedId) => ({
              siteId: req.params.id,
              deedId: linkedDeedId,
              isPrimary: linkedDeedId === primaryDeedId,
            })),
          });
        }
      }

      return tx.investmentSite.findUnique({
        where: { id: req.params.id },
        include: siteInclude,
      });
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
