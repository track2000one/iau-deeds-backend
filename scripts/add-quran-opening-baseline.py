from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')
original = text

inventory_schema = """const quranInventorySchema = z.object({
  siteId: z.string().min(1),
  largeCount: z.coerce.number().int().min(0).max(100000).default(0),
  mediumCount: z.coerce.number().int().min(0).max(100000).default(0),
  smallCount: z.coerce.number().int().min(0).max(100000).default(0),
  damagedCount: z.coerce.number().int().min(0).max(100000).default(0),
  neededCount: z.coerce.number().int().min(0).max(100000).default(0),
  countedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});
"""
opening_schema = inventory_schema + """
const quranOpeningBaselineSchema = z.object({
  siteId: z.string().min(1),
  largeCount: z.coerce.number().int().min(0).max(1000000).default(0),
  mediumCount: z.coerce.number().int().min(0).max(1000000).default(0),
  smallCount: z.coerce.number().int().min(0).max(1000000).default(0),
  recommendedWithdrawalCount: z.coerce.number().int().min(0).max(1000000).default(0),
  countedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const QURAN_OPENING_BASELINE_SITE_ACTION = 'quran_opening_baseline_site';
const QURAN_OPENING_BASELINE_CLOSED_ACTION = 'quran_opening_baseline_closed';
"""
if inventory_schema not in text:
    raise SystemExit('Missing Quran inventory schema anchor')
text = text.replace(inventory_schema, opening_schema, 1)

helper_anchor = """const getQuranSiteSystemStock = async (client, siteId) => {
  const latestInventory = await client.mosqueQuranInventory.findFirst({
    where: { siteId },
    orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
  });
  const movements = await client.mosqueQuranStockMovement.findMany({
    where: { siteId, movementType: { in: ['distribution', 'return', 'site_withdrawal'] } },
    orderBy: [{ movementAt: 'asc' }, { createdAt: 'asc' }],
  });
  return { latestInventory, systemStock: quranSiteStockFromRows(latestInventory, movements) };
};
"""
helper_block = helper_anchor + """
const getQuranOpeningBaselineState = async () => {
  const [sites, baselineLogs, closedLog] = await Promise.all([
    prisma.mosqueSite.findMany({
      select: { id: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true, campusLocation: true, status: true },
      orderBy: [{ name: 'asc' }],
    }),
    prisma.auditLog.findMany({
      where: { module: 'mosques', action: QURAN_OPENING_BASELINE_SITE_ACTION },
      orderBy: [{ createdAt: 'asc' }],
    }),
    prisma.auditLog.findFirst({
      where: { module: 'mosques', action: QURAN_OPENING_BASELINE_CLOSED_ACTION },
      orderBy: [{ createdAt: 'desc' }],
    }),
  ]);

  const latestBySite = new Map();
  for (const log of baselineLogs) {
    if (!log.entityId) continue;
    latestBySite.set(log.entityId, log);
  }

  const items = sites.map((site) => {
    const log = latestBySite.get(site.id) || null;
    const details = log?.newData && typeof log.newData === 'object' ? log.newData : {};
    return {
      site,
      counted: Boolean(log),
      baseline: log ? {
        largeCount: Number(details.largeCount || 0),
        mediumCount: Number(details.mediumCount || 0),
        smallCount: Number(details.smallCount || 0),
        totalCount: Number(details.totalCount || 0),
        recommendedWithdrawalCount: Number(details.recommendedWithdrawalCount || 0),
        countedAt: details.countedAt || log.createdAt,
        countedByName: details.countedByName || log.username || log.userEmail || null,
        notes: details.notes || null,
        inventoryId: details.inventoryId || null,
      } : null,
    };
  });
  const countedSites = items.filter((item) => item.counted).length;
  return {
    closed: Boolean(closedLog),
    closedAt: closedLog?.createdAt || null,
    closedByName: closedLog?.username || closedLog?.userEmail || null,
    totalSites: items.length,
    countedSites,
    remainingSites: Math.max(items.length - countedSites, 0),
    items,
  };
};
"""
if helper_anchor not in text:
    raise SystemExit('Missing Quran site stock helper anchor')
text = text.replace(helper_anchor, helper_block, 1)

route_anchor = "router.get('/quran-stock/dashboard', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {"
opening_routes = """router.get('/quran-stock/opening-baseline', requireRoles('head'), async (_req, res, next) => {
  try {
    res.json(await getQuranOpeningBaselineState());
  } catch (error) { next(error); }
});

router.post('/quran-stock/opening-baseline', requireRoles('head'), async (req, res, next) => {
  try {
    const currentState = await getQuranOpeningBaselineState();
    if (currentState.closed) return res.status(409).json({ message: 'تم اعتماد وإقفال الجرد التأسيسي، ولا يمكن تعديل الأرصدة الافتتاحية بعد الإقفال' });

    const input = quranOpeningBaselineSchema.parse(req.body || {});
    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true, name: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });

    const totalCount = input.largeCount + input.mediumCount + input.smallCount;
    if (input.recommendedWithdrawalCount > totalCount) {
      return res.status(400).json({ message: 'عدد المصاحف الموصى بسحبها لا يمكن أن يتجاوز إجمالي المصاحف الموجودة في الموقع' });
    }

    const countedAt = input.countedAt || new Date();
    const countedByName = req.authUser?.username || req.authUser?.email || null;
    const inventory = await prisma.$transaction(async (tx) => {
      const row = await tx.mosqueQuranInventory.create({
        data: {
          siteId: site.id,
          largeCount: input.largeCount,
          mediumCount: input.mediumCount,
          smallCount: input.smallCount,
          damagedCount: 0,
          neededCount: 0,
          countedAt,
          countedBy: req.authUser?.id || null,
          countedByName,
          notes: nullableText(input.notes),
        },
      });
      await tx.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: QURAN_OPENING_BASELINE_SITE_ACTION,
          module: 'mosques',
          entity: 'MosqueSite',
          entityId: site.id,
          entityLabel: site.name,
          description: `جرد تأسيسي للمصاحف — ${site.name} — الإجمالي ${totalCount}`,
          details: { siteId: site.id, inventoryId: row.id, recommendedWithdrawalCount: input.recommendedWithdrawalCount },
          newData: {
            inventoryId: row.id,
            siteId: site.id,
            largeCount: input.largeCount,
            mediumCount: input.mediumCount,
            smallCount: input.smallCount,
            totalCount,
            recommendedWithdrawalCount: input.recommendedWithdrawalCount,
            countedAt,
            countedByName,
            notes: nullableText(input.notes),
          },
        },
      });
      return row;
    });

    res.status(201).json({
      message: 'تم اعتماد الرصيد الافتتاحي للموقع دون الخصم من مكتبة المصاحف',
      inventory: { ...inventory, totalCount },
      state: await getQuranOpeningBaselineState(),
    });
  } catch (error) { next(error); }
});

router.post('/quran-stock/opening-baseline/close', requireRoles('head'), async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || '').trim();
    if (confirmation !== 'اعتماد الجرد التأسيسي') {
      return res.status(400).json({ message: 'اكتب عبارة «اعتماد الجرد التأسيسي» لتأكيد الإقفال النهائي' });
    }
    const state = await getQuranOpeningBaselineState();
    if (state.closed) return res.status(409).json({ message: 'الجرد التأسيسي معتمد ومقفل مسبقًا' });
    if (state.remainingSites > 0) {
      return res.status(409).json({ message: `لا يمكن إقفال الجرد التأسيسي قبل حصر جميع المواقع. المتبقي ${state.remainingSites} موقعًا` });
    }

    await prisma.auditLog.create({
      data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action: QURAN_OPENING_BASELINE_CLOSED_ACTION,
        module: 'mosques',
        entity: 'MosqueQuranOpeningBaseline',
        entityLabel: 'الجرد التأسيسي للمصاحف',
        description: `اعتماد وإقفال الجرد التأسيسي للمصاحف بعد حصر ${state.countedSites} موقعًا`,
        newData: { totalSites: state.totalSites, countedSites: state.countedSites, closedAt: new Date() },
      },
    });

    res.json({ message: 'تم اعتماد وإقفال الجرد التأسيسي للمصاحف. أي حركة لاحقة ستتم من خلال الإضافة من المكتبة أو السحب.', state: await getQuranOpeningBaselineState() });
  } catch (error) { next(error); }
});

""" + route_anchor
if route_anchor not in text:
    raise SystemExit('Missing Quran dashboard route anchor')
text = text.replace(route_anchor, opening_routes, 1)

reset_anchor = """      await tx.mosqueQuranWarehouse.deleteMany({});

      return { warehouses, movements, inventories, notifications };"""
reset_replacement = """      await tx.mosqueQuranWarehouse.deleteMany({});
      await tx.auditLog.deleteMany({
        where: { module: 'mosques', action: { in: [QURAN_OPENING_BASELINE_SITE_ACTION, QURAN_OPENING_BASELINE_CLOSED_ACTION] } },
      });

      return { warehouses, movements, inventories, notifications };"""
if reset_anchor not in text:
    raise SystemExit('Missing Quran reset transaction anchor')
text = text.replace(reset_anchor, reset_replacement, 1)

if text == original:
    raise SystemExit('No backend changes applied')

path.write_text(text, encoding='utf-8')
print('Quran opening baseline backend added')
