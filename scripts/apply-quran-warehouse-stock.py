from pathlib import Path
import re

schema_path = Path('prisma/schema.prisma')
routes_path = Path('src/routes/mosques.routes.js')
schema = schema_path.read_text(encoding='utf-8')
routes = routes_path.read_text(encoding='utf-8')

# -----------------------------------------------------------------------------
# Prisma models: central Quran warehouses + immutable movement ledger.
# -----------------------------------------------------------------------------
if 'model MosqueQuranWarehouse {' not in schema:
    relation_line = '  quranInventories MosqueQuranInventory[]\n'
    if relation_line not in schema:
        raise SystemExit('MosqueSite quranInventories relation marker not found')
    schema = schema.replace(
        relation_line,
        relation_line + '  quranStockMovements MosqueQuranStockMovement[]\n',
        1,
    )

    inventory_match = re.search(r'model MosqueQuranInventory \{.*?\n\}', schema, re.S)
    if not inventory_match:
        raise SystemExit('MosqueQuranInventory model not found')

    models = r'''

model MosqueQuranWarehouse {
  id             String   @id @default(cuid())
  code           String   @unique
  name           String
  location       String?
  active         Boolean  @default(true)
  minLargeCount  Int      @default(0)
  minMediumCount Int      @default(0)
  minSmallCount  Int      @default(0)
  notes          String?
  createdBy      String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  movements MosqueQuranStockMovement[]

  @@index([active])
  @@index([name])
}

model MosqueQuranStockMovement {
  id             String   @id @default(cuid())
  movementNumber String   @unique
  movementType   String
  warehouseId    String
  siteId         String?
  largeCount     Int      @default(0)
  mediumCount    Int      @default(0)
  smallCount     Int      @default(0)
  totalCount     Int      @default(0)
  referenceNumber String?
  movementAt     DateTime @default(now())
  notes          String?
  createdBy      String?
  createdByName  String?
  createdAt      DateTime @default(now())

  warehouse MosqueQuranWarehouse @relation(fields: [warehouseId], references: [id], onDelete: Restrict)
  site      MosqueSite?           @relation(fields: [siteId], references: [id], onDelete: Restrict)

  @@index([warehouseId])
  @@index([siteId])
  @@index([movementType])
  @@index([movementAt])
  @@index([createdAt])
}
'''
    schema = schema[:inventory_match.end()] + models + schema[inventory_match.end():]

# -----------------------------------------------------------------------------
# Validation schemas.
# -----------------------------------------------------------------------------
if 'const quranWarehouseSchema = z.object({' not in routes:
    q_start = routes.find('const quranInventorySchema = z.object({')
    if q_start < 0:
        raise SystemExit('quranInventorySchema marker not found')
    q_end = routes.find('\n});', q_start)
    if q_end < 0:
        raise SystemExit('quranInventorySchema end not found')
    q_end += len('\n});')
    schemas = r'''

const quranWarehouseSchema = z.object({
  code: z.string().trim().min(2).max(40).optional().nullable(),
  name: z.string().trim().min(2).max(180),
  location: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional().default(true),
  minLargeCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  minMediumCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  minSmallCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const quranStockMovementSchema = z.object({
  movementType: z.enum(['receipt', 'distribution', 'return', 'warehouse_damage', 'adjustment_in', 'adjustment_out']),
  warehouseId: z.string().min(1),
  siteId: z.string().min(1).optional().nullable(),
  largeCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  mediumCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  smallCount: z.coerce.number().int().min(0).max(1000000).optional().default(0),
  referenceNumber: z.string().trim().max(120).optional().nullable(),
  movementAt: z.coerce.date().optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});
'''
    routes = routes[:q_end] + schemas + routes[q_end:]

# -----------------------------------------------------------------------------
# Warehouse stock routes and accounting helpers.
# -----------------------------------------------------------------------------
if "router.get('/quran-stock/dashboard'" not in routes:
    marker = '// -----------------------------------------------------------------------------\n// Quran inventory: each save creates a dated snapshot.'
    insert_at = routes.find(marker)
    if insert_at < 0:
        raise SystemExit('Quran inventory routes marker not found')

    stock_block = r'''
// -----------------------------------------------------------------------------
// Quran warehouse & distribution stock ledger.
// Warehouses are the source of truth for central stock. Every receipt,
// distribution, return, damage or adjustment is posted as an immutable movement.
// Site system stock starts from the latest physical inventory snapshot and then
// applies subsequent distribution/return movements, keeping physical counts and
// accounting movements auditable without overwriting history.
// -----------------------------------------------------------------------------
const QURAN_WAREHOUSE_POSITIVE_TYPES = new Set(['receipt', 'return', 'adjustment_in']);
const QURAN_WAREHOUSE_NEGATIVE_TYPES = new Set(['distribution', 'warehouse_damage', 'adjustment_out']);
const QURAN_SITE_POSITIVE_TYPES = new Set(['distribution']);
const QURAN_SITE_NEGATIVE_TYPES = new Set(['return']);

const quranZeroCounts = () => ({ largeCount: 0, mediumCount: 0, smallCount: 0, totalCount: 0 });
const quranMovementCounts = (row) => ({
  largeCount: Number(row?.largeCount || 0),
  mediumCount: Number(row?.mediumCount || 0),
  smallCount: Number(row?.smallCount || 0),
  totalCount: Number(row?.totalCount ?? ((row?.largeCount || 0) + (row?.mediumCount || 0) + (row?.smallCount || 0))),
});
const addQuranCounts = (target, counts, sign = 1) => {
  target.largeCount += sign * counts.largeCount;
  target.mediumCount += sign * counts.mediumCount;
  target.smallCount += sign * counts.smallCount;
  target.totalCount += sign * counts.totalCount;
  return target;
};
const quranWarehouseBalanceFromRows = (rows) => {
  const balance = quranZeroCounts();
  for (const row of rows || []) {
    const sign = QURAN_WAREHOUSE_POSITIVE_TYPES.has(row.movementType) ? 1 : QURAN_WAREHOUSE_NEGATIVE_TYPES.has(row.movementType) ? -1 : 0;
    if (sign) addQuranCounts(balance, quranMovementCounts(row), sign);
  }
  return balance;
};
const quranSiteStockFromRows = (latestInventory, rows) => {
  const stock = latestInventory
    ? {
        largeCount: Number(latestInventory.largeCount || 0),
        mediumCount: Number(latestInventory.mediumCount || 0),
        smallCount: Number(latestInventory.smallCount || 0),
        totalCount: Number(latestInventory.largeCount || 0) + Number(latestInventory.mediumCount || 0) + Number(latestInventory.smallCount || 0),
      }
    : quranZeroCounts();
  const cutoff = latestInventory?.countedAt ? new Date(latestInventory.countedAt).getTime() : null;
  for (const row of rows || []) {
    if (cutoff != null && new Date(row.movementAt).getTime() <= cutoff) continue;
    const sign = QURAN_SITE_POSITIVE_TYPES.has(row.movementType) ? 1 : QURAN_SITE_NEGATIVE_TYPES.has(row.movementType) ? -1 : 0;
    if (sign) addQuranCounts(stock, quranMovementCounts(row), sign);
  }
  return stock;
};
const quranHasEnough = (balance, counts) => (
  balance.largeCount >= counts.largeCount &&
  balance.mediumCount >= counts.mediumCount &&
  balance.smallCount >= counts.smallCount
);
const quranShortage = (warehouse, balance) => ({
  largeCount: Math.max(Number(warehouse.minLargeCount || 0) - balance.largeCount, 0),
  mediumCount: Math.max(Number(warehouse.minMediumCount || 0) - balance.mediumCount, 0),
  smallCount: Math.max(Number(warehouse.minSmallCount || 0) - balance.smallCount, 0),
  totalCount:
    Math.max(Number(warehouse.minLargeCount || 0) - balance.largeCount, 0) +
    Math.max(Number(warehouse.minMediumCount || 0) - balance.mediumCount, 0) +
    Math.max(Number(warehouse.minSmallCount || 0) - balance.smallCount, 0),
});

const getQuranWarehouseBalance = async (client, warehouseId) => {
  const rows = await client.mosqueQuranStockMovement.findMany({
    where: { warehouseId },
    select: { movementType: true, largeCount: true, mediumCount: true, smallCount: true, totalCount: true },
  });
  return quranWarehouseBalanceFromRows(rows);
};

const getQuranSiteSystemStock = async (client, siteId) => {
  const latestInventory = await client.mosqueQuranInventory.findFirst({
    where: { siteId },
    orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
  });
  const movements = await client.mosqueQuranStockMovement.findMany({
    where: { siteId, movementType: { in: ['distribution', 'return'] } },
    orderBy: [{ movementAt: 'asc' }, { createdAt: 'asc' }],
  });
  return { latestInventory, systemStock: quranSiteStockFromRows(latestInventory, movements) };
};

router.get('/quran-stock/dashboard', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const managedIds = await getManagedSiteIds(req, context);
    const siteWhere = managedIds === null ? {} : { id: { in: managedIds } };

    const [warehouses, allWarehouseMovements, sites] = await Promise.all([
      prisma.mosqueQuranWarehouse.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
      prisma.mosqueQuranStockMovement.findMany({
        include: { warehouse: { select: { id: true, code: true, name: true } }, site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } } },
        orderBy: [{ movementAt: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.mosqueSite.findMany({
        where: siteWhere,
        select: { id: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true, campusLocation: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const warehouseRows = warehouses.map((warehouse) => {
      const movements = allWarehouseMovements.filter((row) => row.warehouseId === warehouse.id);
      const balance = quranWarehouseBalanceFromRows(movements);
      const shortage = quranShortage(warehouse, balance);
      return { ...warehouse, balance, shortage, lowStock: shortage.totalCount > 0 };
    });

    const siteIds = sites.map((site) => site.id);
    const [inventoryRows, siteMovementRows] = siteIds.length
      ? await Promise.all([
          prisma.mosqueQuranInventory.findMany({
            where: { siteId: { in: siteIds } },
            orderBy: [{ countedAt: 'desc' }, { createdAt: 'desc' }],
          }),
          prisma.mosqueQuranStockMovement.findMany({
            where: { siteId: { in: siteIds }, movementType: { in: ['distribution', 'return'] } },
            orderBy: [{ movementAt: 'asc' }, { createdAt: 'asc' }],
          }),
        ])
      : [[], []];

    const latestBySite = new Map();
    for (const row of inventoryRows) if (!latestBySite.has(row.siteId)) latestBySite.set(row.siteId, row);
    const movementsBySite = new Map();
    for (const row of siteMovementRows) {
      if (!movementsBySite.has(row.siteId)) movementsBySite.set(row.siteId, []);
      movementsBySite.get(row.siteId).push(row);
    }

    const siteStock = sites.map((site) => {
      const latestInventory = latestBySite.get(site.id) || null;
      const systemStock = quranSiteStockFromRows(latestInventory, movementsBySite.get(site.id) || []);
      return { site, latestInventory, systemStock };
    });

    const summary = {
      warehouseTotal: warehouseRows.reduce((sum, row) => sum + row.balance.totalCount, 0),
      warehouseLarge: warehouseRows.reduce((sum, row) => sum + row.balance.largeCount, 0),
      warehouseMedium: warehouseRows.reduce((sum, row) => sum + row.balance.mediumCount, 0),
      warehouseSmall: warehouseRows.reduce((sum, row) => sum + row.balance.smallCount, 0),
      receivedTotal: allWarehouseMovements.filter((row) => row.movementType === 'receipt').reduce((sum, row) => sum + row.totalCount, 0),
      distributedTotal: allWarehouseMovements.filter((row) => row.movementType === 'distribution').reduce((sum, row) => sum + row.totalCount, 0),
      returnedTotal: allWarehouseMovements.filter((row) => row.movementType === 'return').reduce((sum, row) => sum + row.totalCount, 0),
      damagedTotal: allWarehouseMovements.filter((row) => row.movementType === 'warehouse_damage').reduce((sum, row) => sum + row.totalCount, 0),
      siteSystemTotal: siteStock.reduce((sum, row) => sum + row.systemStock.totalCount, 0),
      siteNeedTotal: siteStock.reduce((sum, row) => sum + Number(row.latestInventory?.neededCount || 0), 0),
      lowStockWarehouses: warehouseRows.filter((row) => row.lowStock).length,
      shortageTotal: warehouseRows.reduce((sum, row) => sum + row.shortage.totalCount, 0),
    };

    const visibleRecentMovements = context.role === 'head'
      ? allWarehouseMovements.slice(0, 80)
      : allWarehouseMovements.filter((row) => row.siteId && siteIds.includes(row.siteId)).slice(0, 80);

    res.json({ warehouses: warehouseRows, summary, sites: siteStock, recentMovements: visibleRecentMovements });
  } catch (error) { next(error); }
});

router.post('/quran-warehouses', requireRoles('head'), async (req, res, next) => {
  try {
    const input = quranWarehouseSchema.parse(req.body || {});
    const code = nullableText(input.code) || `QW-${new Date().getFullYear()}-${randomDigits(4)}`;
    const created = await prisma.mosqueQuranWarehouse.create({
      data: {
        code,
        name: input.name,
        location: nullableText(input.location),
        active: input.active !== false,
        minLargeCount: input.minLargeCount || 0,
        minMediumCount: input.minMediumCount || 0,
        minSmallCount: input.minSmallCount || 0,
        notes: nullableText(input.notes),
        createdBy: req.authUser?.id || null,
      },
    });
    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null, username: req.authUser?.username || null, userEmail: req.authUser?.email || null, userRole: req.authUser?.role || null,
        action: 'quran_warehouse_create', module: 'mosques', entity: 'MosqueQuranWarehouse', entityId: created.id, entityLabel: created.name,
        description: `إنشاء مستودع مصاحف: ${created.name}`, newData: created,
      } });
    } catch {}
    res.status(201).json({ ...created, balance: quranZeroCounts(), shortage: quranShortage(created, quranZeroCounts()), lowStock: quranShortage(created, quranZeroCounts()).totalCount > 0 });
  } catch (error) {
    if (error?.code === 'P2002') return res.status(409).json({ message: 'رمز المستودع مستخدم مسبقًا' });
    next(error);
  }
});

router.patch('/quran-warehouses/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const input = quranWarehouseSchema.partial().parse(req.body || {});
    const data = {};
    if (input.code !== undefined) data.code = nullableText(input.code);
    if (input.name !== undefined) data.name = input.name;
    if (input.location !== undefined) data.location = nullableText(input.location);
    if (input.active !== undefined) data.active = input.active;
    if (input.minLargeCount !== undefined) data.minLargeCount = input.minLargeCount;
    if (input.minMediumCount !== undefined) data.minMediumCount = input.minMediumCount;
    if (input.minSmallCount !== undefined) data.minSmallCount = input.minSmallCount;
    if (input.notes !== undefined) data.notes = nullableText(input.notes);
    const updated = await prisma.mosqueQuranWarehouse.update({ where: { id: req.params.id }, data });
    const balance = await getQuranWarehouseBalance(prisma, updated.id);
    const shortage = quranShortage(updated, balance);
    res.json({ ...updated, balance, shortage, lowStock: shortage.totalCount > 0 });
  } catch (error) {
    if (error?.code === 'P2002') return res.status(409).json({ message: 'رمز المستودع مستخدم مسبقًا' });
    next(error);
  }
});

router.get('/quran-stock/movements', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const managedIds = await getManagedSiteIds(req, context);
    const where = {};
    if (req.query.warehouseId) where.warehouseId = String(req.query.warehouseId);
    if (req.query.siteId) where.siteId = String(req.query.siteId);
    if (managedIds !== null) where.siteId = { in: managedIds };
    const rows = await prisma.mosqueQuranStockMovement.findMany({
      where,
      include: { warehouse: { select: { id: true, code: true, name: true } }, site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } } },
      orderBy: [{ movementAt: 'desc' }, { createdAt: 'desc' }],
      take: 300,
    });
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/quran-stock/movements', requireRoles('head'), async (req, res, next) => {
  try {
    const input = quranStockMovementSchema.parse(req.body || {});
    const counts = {
      largeCount: input.largeCount || 0,
      mediumCount: input.mediumCount || 0,
      smallCount: input.smallCount || 0,
      totalCount: (input.largeCount || 0) + (input.mediumCount || 0) + (input.smallCount || 0),
    };
    if (counts.totalCount <= 0) return res.status(400).json({ message: 'يجب إدخال كمية واحدة على الأقل من المصاحف' });
    if (['distribution', 'return'].includes(input.movementType) && !input.siteId) return res.status(400).json({ message: 'المسجد أو المصلى إلزامي في عمليات التوزيع والإرجاع' });

    const movement = await prisma.$transaction(async (tx) => {
      const warehouse = await tx.mosqueQuranWarehouse.findUnique({ where: { id: input.warehouseId } });
      if (!warehouse) {
        const error = new Error('المستودع غير موجود'); error.statusCode = 404; throw error;
      }
      if (!warehouse.active && input.movementType !== 'return') {
        const error = new Error('المستودع غير نشط ولا يقبل حركات جديدة'); error.statusCode = 400; throw error;
      }

      if (QURAN_WAREHOUSE_NEGATIVE_TYPES.has(input.movementType)) {
        const balance = await getQuranWarehouseBalance(tx, warehouse.id);
        if (!quranHasEnough(balance, counts)) {
          const error = new Error(`الرصيد غير كافٍ. المتاح: كبير ${balance.largeCount}، متوسط ${balance.mediumCount}، صغير ${balance.smallCount}`);
          error.statusCode = 400; throw error;
        }
      }

      let site = null;
      if (input.siteId) {
        site = await tx.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true, name: true } });
        if (!site) { const error = new Error('المسجد أو المصلى غير موجود'); error.statusCode = 404; throw error; }
      }

      if (input.movementType === 'return' && site) {
        const current = await getQuranSiteSystemStock(tx, site.id);
        if (!quranHasEnough(current.systemStock, counts)) {
          const error = new Error(`لا يمكن إرجاع كمية أكبر من الرصيد النظامي للموقع. الرصيد: كبير ${current.systemStock.largeCount}، متوسط ${current.systemStock.mediumCount}، صغير ${current.systemStock.smallCount}`);
          error.statusCode = 400; throw error;
        }
      }

      const created = await tx.mosqueQuranStockMovement.create({
        data: {
          movementNumber: trackingNumber('QMV'),
          movementType: input.movementType,
          warehouseId: warehouse.id,
          siteId: site?.id || null,
          ...counts,
          referenceNumber: nullableText(input.referenceNumber),
          movementAt: input.movementAt || new Date(),
          notes: nullableText(input.notes),
          createdBy: req.authUser?.id || null,
          createdByName: req.authUser?.username || req.authUser?.email || null,
        },
        include: { warehouse: { select: { id: true, code: true, name: true } }, site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } } },
      });
      return created;
    });

    if (movement.movementType === 'distribution' && movement.siteId) {
      await notify({ siteId: movement.siteId, title: 'تم صرف مصاحف للموقع', message: `تم توزيع ${movement.totalCount} مصحفًا على ${movement.site?.name || 'الموقع'} بموجب ${movement.movementNumber}`, entityType: 'quran_stock_movement', entityId: movement.id });
    }

    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null, username: req.authUser?.username || null, userEmail: req.authUser?.email || null, userRole: req.authUser?.role || null,
        action: `quran_stock_${movement.movementType}`, module: 'mosques', entity: 'MosqueQuranStockMovement', entityId: movement.id, entityLabel: movement.movementNumber,
        description: `حركة مخزون مصاحف ${movement.movementNumber} — إجمالي ${movement.totalCount}`, newData: movement,
      } });
    } catch {}

    res.status(201).json(movement);
  } catch (error) { next(error); }
});

'''
    routes = routes[:insert_at] + stock_block + routes[insert_at:]

schema_path.write_text(schema, encoding='utf-8')
routes_path.write_text(routes, encoding='utf-8')
print('Applied Quran warehouse and stock ledger backend feature.')
