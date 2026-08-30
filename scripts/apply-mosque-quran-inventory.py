from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

# -----------------------------------------------------------------------------
# Prisma schema: immutable inventory snapshots per mosque/prayer room.
# -----------------------------------------------------------------------------
schema_path = Path('prisma/schema.prisma')
schema = schema_path.read_text(encoding='utf-8')

if 'model MosqueQuranInventory' not in schema:
    schema = replace_once(
        schema,
        '  assignments MosqueUserAssignment[]\n',
        '  assignments MosqueUserAssignment[]\n  quranInventories MosqueQuranInventory[]\n',
        'MosqueSite quran relation',
    )

    quran_model = r'''
model MosqueQuranInventory {
  id            String   @id @default(cuid())
  siteId        String
  largeCount    Int      @default(0)
  mediumCount   Int      @default(0)
  smallCount    Int      @default(0)
  damagedCount  Int      @default(0)
  neededCount   Int      @default(0)
  countedAt     DateTime @default(now())
  countedBy     String?
  countedByName String?
  notes         String?
  createdAt     DateTime @default(now())

  site MosqueSite @relation(fields: [siteId], references: [id], onDelete: Cascade)

  @@index([siteId])
  @@index([countedAt])
  @@index([createdAt])
}

'''
    schema = replace_once(schema, 'model MosqueRequest {\n', quran_model + 'model MosqueRequest {\n', 'Quran inventory model')

schema_path.write_text(schema, encoding='utf-8')

# -----------------------------------------------------------------------------
# API routes.
# -----------------------------------------------------------------------------
routes_path = Path('src/routes/mosques.routes.js')
routes = routes_path.read_text(encoding='utf-8')

if 'const quranInventorySchema = z.object' not in routes:
    anchor = '''const leaveSchema = z.object({
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
'''
    addition = anchor + r'''

const quranInventorySchema = z.object({
  siteId: z.string().min(1),
  largeCount: z.coerce.number().int().min(0).max(100000).default(0),
  mediumCount: z.coerce.number().int().min(0).max(100000).default(0),
  smallCount: z.coerce.number().int().min(0).max(100000).default(0),
  damagedCount: z.coerce.number().int().min(0).max(100000).default(0),
  neededCount: z.coerce.number().int().min(0).max(100000).default(0),
  countedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});
'''
    routes = replace_once(routes, anchor, addition, 'Quran inventory schema')

if 'const assertQuranInventorySiteAccess' not in routes:
    anchor = '''const requireRoles = (...roles) => async (req, res, next) => {
'''
    helper = r'''const assertQuranInventorySiteAccess = async (req, siteId, context = null) => {
  const ctx = context || req.mosqueRole || await getModuleRole(req);
  if (ctx.role === 'head') return ctx;
  if (ctx.role === 'supervisor') {
    await assertSupervisorSiteAccess(req, siteId, ctx);
    return ctx;
  }
  if (ctx.role === 'personnel' && ctx.siteId === siteId) return ctx;
  const error = new Error('لا تملك صلاحية إدارة جرد المصاحف لهذا الموقع');
  error.statusCode = 403;
  throw error;
};

'''
    routes = replace_once(routes, anchor, helper + anchor, 'Quran inventory access helper')

if "router.get('/quran-inventory'" not in routes:
    route_anchor = "router.get('/personnel', requireRoles('head', 'supervisor'), async (req, res, next) => {\n"
    if route_anchor not in routes:
        raise SystemExit('personnel route anchor not found')

    block = r'''
// -----------------------------------------------------------------------------
// Quran inventory: each save creates a dated snapshot. The latest snapshot is
// used for current totals while the full history remains available for audit.
// damagedCount is a subset of the size counts, not an addition to total stock.
// -----------------------------------------------------------------------------
router.get('/quran-inventory', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    let siteWhere = {};
    if (context.role === 'supervisor') {
      const ids = await getManagedSiteIds(req, context);
      siteWhere = { id: { in: ids || [] } };
    } else if (context.role === 'personnel') {
      siteWhere = context.siteId ? { id: context.siteId } : { id: '__none__' };
    }

    const sites = await prisma.mosqueSite.findMany({
      where: siteWhere,
      select: { id: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true, campusLocation: true, status: true },
      orderBy: { name: 'asc' },
    });
    const siteIds = sites.map((site) => site.id);
    const snapshots = siteIds.length ? await prisma.mosqueQuranInventory.findMany({
      where: { siteId: { in: siteIds } },
      orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
    }) : [];

    const latestBySite = new Map();
    for (const row of snapshots) {
      if (!latestBySite.has(row.siteId)) latestBySite.set(row.siteId, row);
    }

    const normalize = (row) => row ? {
      ...row,
      totalCount: row.largeCount + row.mediumCount + row.smallCount,
    } : null;

    const items = sites.map((site) => ({ site, latest: normalize(latestBySite.get(site.id) || null) }));
    const summary = items.reduce((acc, item) => {
      acc.sites += 1;
      if (!item.latest) return acc;
      acc.countedSites += 1;
      acc.large += item.latest.largeCount;
      acc.medium += item.latest.mediumCount;
      acc.small += item.latest.smallCount;
      acc.damaged += item.latest.damagedCount;
      acc.needed += item.latest.neededCount;
      acc.total += item.latest.totalCount;
      return acc;
    }, { sites: 0, countedSites: 0, total: 0, large: 0, medium: 0, small: 0, damaged: 0, needed: 0 });

    res.json({ items, summary });
  } catch (error) { next(error); }
});

router.get('/quran-inventory/:siteId/history', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    await assertQuranInventorySiteAccess(req, req.params.siteId, context);
    const site = await prisma.mosqueSite.findUnique({ where: { id: req.params.siteId }, select: { id: true, name: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });
    const rows = await prisma.mosqueQuranInventory.findMany({
      where: { siteId: site.id },
      orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(rows.map((row) => ({ ...row, totalCount: row.largeCount + row.mediumCount + row.smallCount, site })));
  } catch (error) { next(error); }
});

router.post('/quran-inventory', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const input = quranInventorySchema.parse(req.body || {});
    await assertQuranInventorySiteAccess(req, input.siteId, context);
    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true, name: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });

    const totalCount = input.largeCount + input.mediumCount + input.smallCount;
    if (input.damagedCount > totalCount) {
      return res.status(400).json({ message: 'عدد المصاحف التالفة لا يمكن أن يتجاوز إجمالي المصاحف حسب الأحجام' });
    }

    const row = await prisma.mosqueQuranInventory.create({
      data: {
        siteId: input.siteId,
        largeCount: input.largeCount,
        mediumCount: input.mediumCount,
        smallCount: input.smallCount,
        damagedCount: input.damagedCount,
        neededCount: input.neededCount,
        countedAt: input.countedAt || new Date(),
        countedBy: req.authUser?.id || null,
        countedByName: req.authUser?.username || req.authUser?.email || null,
        notes: nullableText(input.notes),
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: 'quran_inventory_count',
          module: 'mosques',
          entity: 'quran_inventory',
          entityId: row.id,
          entityLabel: site.name,
          description: `تحديث جرد المصاحف — الإجمالي ${totalCount} — الاحتياج ${input.neededCount}`,
          details: { siteId: site.id, largeCount: input.largeCount, mediumCount: input.mediumCount, smallCount: input.smallCount, damagedCount: input.damagedCount, neededCount: input.neededCount, countedAt: row.countedAt },
          newData: row,
        },
      });
    } catch (auditError) {
      console.warn('Unable to write Quran inventory audit log:', auditError?.message || auditError);
    }

    res.status(201).json({ ...row, totalCount, site });
  } catch (error) { next(error); }
});

'''
    routes = routes.replace(route_anchor, block + route_anchor, 1)

routes_path.write_text(routes, encoding='utf-8')
print('Mosque Quran inventory backend applied.')
