import fs from 'node:fs';

const schemaPath = 'prisma/schema.prisma';
let schema = fs.readFileSync(schemaPath, 'utf8');

const buildingModel = `model MosqueBuilding {
  id                  String   @id @default(cuid())
  buildingNumber      String   @unique
  name                String?
  campusLocation      String?
  city                String?
  district            String?
  expectedUsers       Int?
  coverageStatus      String   @default("unassessed")
  creationFeasibility String   @default("under_study")
  unavailableReason   String?
  approvedAlternative String?
  notes               String?
  createdBy           String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  sites MosqueSite[]

  @@index([coverageStatus])
  @@index([creationFeasibility])
}

`;

if (!schema.includes('model MosqueBuilding {')) {
  if (!schema.includes('model MosqueSite {')) throw new Error('MosqueSite model not found');
  schema = schema.replace('model MosqueSite {', buildingModel + 'model MosqueSite {');
}

const mosqueSiteMatch = schema.match(/model MosqueSite \{[\s\S]*?\n\}/);
if (!mosqueSiteMatch) throw new Error('Unable to locate MosqueSite model block');
let mosqueSiteBlock = mosqueSiteMatch[0];
if (!mosqueSiteBlock.includes('spatialRelation')) {
  mosqueSiteBlock = mosqueSiteBlock.replace(
    '  prayerRoomGender String?\n',
    '  prayerRoomGender String?\n  spatialRelation  String   @default("independent")\n  buildingId       String?\n  floor            String?\n  roomNumber       String?\n',
  );
}
if (!mosqueSiteBlock.includes('building MosqueBuilding?')) {
  mosqueSiteBlock = mosqueSiteBlock.replace(
    /\n\}$/, 
    '\n  building MosqueBuilding? @relation(fields: [buildingId], references: [id], onDelete: SetNull)\n\n  @@index([buildingId])\n\n}',
  );
}
schema = schema.replace(mosqueSiteMatch[0], mosqueSiteBlock);
fs.writeFileSync(schemaPath, schema);

const routePath = 'src/routes/mosques.routes.js';
let source = fs.readFileSync(routePath, 'utf8');

if (!source.includes("spatialRelation: z.enum(['inside_building', 'independent'])")) {
  source = source.replace(
    "  prayerRoomGender: z.enum(['men', 'women']).optional().nullable(),\n",
    "  prayerRoomGender: z.enum(['men', 'women']).optional().nullable(),\n  spatialRelation: z.enum(['inside_building', 'independent']).default('independent'),\n  buildingId: z.string().trim().optional().nullable(),\n  floor: z.string().trim().optional().nullable(),\n  roomNumber: z.string().trim().optional().nullable(),\n",
  );
}

if (!source.includes('const buildingSchema = z.object({')) {
  const siteStart = source.indexOf('const siteSchema = z.object({');
  const siteEnd = source.indexOf('\n});', siteStart) + 4;
  if (siteStart < 0 || siteEnd < 4) throw new Error('siteSchema not found');
  const helper = `

const buildingSchema = z.object({
  buildingNumber: z.string().trim().min(1).max(100),
  name: z.string().trim().optional().nullable(),
  campusLocation: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  district: z.string().trim().optional().nullable(),
  expectedUsers: z.coerce.number().int().nonnegative().optional().nullable(),
  coverageStatus: z.enum(['unassessed', 'covered', 'needs_prayer_room', 'under_feasibility_study', 'not_feasible_alternative', 'under_implementation']).default('unassessed'),
  creationFeasibility: z.enum(['available', 'unavailable', 'under_study']).default('under_study'),
  unavailableReason: z.string().trim().optional().nullable(),
  approvedAlternative: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});

const assertMosqueBuildingLink = async (input) => {
  if (input.spatialRelation !== 'inside_building') {
    input.buildingId = null;
    input.floor = null;
    input.roomNumber = null;
    return;
  }
  if (!input.buildingId) {
    const error = new Error('رقم المبنى مطلوب عند اختيار داخل مبنى');
    error.statusCode = 400;
    throw error;
  }
  const building = await prisma.mosqueBuilding.findUnique({ where: { id: input.buildingId }, select: { id: true } });
  if (!building) {
    const error = new Error('المبنى المحدد غير موجود في سجل تغطية المباني');
    error.statusCode = 400;
    throw error;
  }
};`;
  source = source.slice(0, siteEnd) + helper + source.slice(siteEnd);
}

if (!source.includes("router.get('/buildings'")) {
  const marker = "router.get('/sites', async (req, res, next) => {";
  if (!source.includes(marker)) throw new Error('sites route marker not found');
  const routes = `router.get('/buildings', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    if (!['head', 'supervisor'].includes(context.role)) return res.json([]);
    const rows = await prisma.mosqueBuilding.findMany({
      include: {
        sites: { select: { id: true, name: true, siteType: true, prayerRoomGender: true, status: true }, orderBy: { name: 'asc' } },
        _count: { select: { sites: true } },
      },
      orderBy: [{ buildingNumber: 'asc' }, { name: 'asc' }],
    });
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/buildings', requireRoles('head'), async (req, res, next) => {
  try {
    const input = buildingSchema.parse(req.body);
    const building = await prisma.mosqueBuilding.create({ data: { ...input, createdBy: req.authUser.id } });
    res.status(201).json(building);
  } catch (error) { next(error); }
});

router.put('/buildings/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const input = buildingSchema.parse(req.body);
    const current = await prisma.mosqueBuilding.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!current) return res.status(404).json({ message: 'المبنى غير موجود' });
    const building = await prisma.mosqueBuilding.update({ where: { id: req.params.id }, data: input });
    res.json(building);
  } catch (error) { next(error); }
});

router.delete('/buildings/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueBuilding.findUnique({ where: { id: req.params.id }, include: { _count: { select: { sites: true } } } });
    if (!current) return res.status(404).json({ message: 'المبنى غير موجود' });
    if (current._count.sites > 0) return res.status(409).json({ message: 'لا يمكن حذف المبنى قبل فك ارتباط المساجد والمصليات التابعة له' });
    await prisma.mosqueBuilding.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (error) { next(error); }
});

`;
  source = source.replace(marker, routes + marker);
}

source = source.replaceAll(
  'include: { _count: { select: { requests: true, tickets: true, personnel: true } } },',
  'include: { building: true, _count: { select: { requests: true, tickets: true, personnel: true } } },',
);

source = source.replaceAll(
  'const input = siteSchema.parse(req.body);',
  'const input = siteSchema.parse(req.body);\n    await assertMosqueBuildingLink(input);',
);

fs.writeFileSync(routePath, source);
