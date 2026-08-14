from pathlib import Path

# Prisma schema
p = Path('prisma/schema.prisma')
s = p.read_text()
old = '''model AccountingTransformationRecord {
  id                  String   @id @default(cuid())
  recordNumber        String   @unique
  recordType          String
  ownershipMode       String   @default("owned")
  committeeStatus     String   @default("not_reviewed")
  entityName          String?
  entityCode          String?
  mofAssetNumber      String?
  entityAssetNumber   String?
  linkedAsset         String?
  assetDescription    String?
  accountingGroup     String?
  accountingGroupCode String?
  accountingAssetCode String?
  region              String?
  city                String?
  censusProgress      Int      @default(0)
  inventoryProgress   Int      @default(0)
  valuationProgress   Int      @default(0)
  overallProgress     Int      @default(0)
  readinessStatus     String   @default("needs_data")
  sourceFingerprint   String?  @unique
  payload             Json
  attachments         Json?
  notes               String?
  createdBy           String?
  updatedBy           String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([recordType])
  @@index([committeeStatus])
  @@index([readinessStatus])
  @@index([entityName])
  @@index([entityAssetNumber])
  @@index([mofAssetNumber])
  @@index([linkedAsset])
  @@index([accountingAssetCode])
  @@index([city])
  @@index([overallProgress])
  @@index([updatedAt])
}'''
new = '''model AccountingTransformationCycle {
  id             String   @id @default(cuid())
  cycleNumber    Int      @unique
  name           String
  description    String?
  status         String   @default("draft")
  isCurrent      Boolean  @default(false)
  basedOnCycleId String?
  sourceFileName String?
  importedAt     DateTime?
  importedBy     String?
  reviewedAt     DateTime?
  reviewedBy     String?
  approvedAt     DateTime?
  approvedBy     String?
  archivedAt     DateTime?
  createdBy      String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  records AccountingTransformationRecord[]

  @@index([status])
  @@index([isCurrent])
  @@index([cycleNumber])
  @@index([createdAt])
}

model AccountingTransformationRecord {
  id                  String   @id @default(cuid())
  recordNumber        String   @unique
  cycleId             String?
  stableKey           String?
  changeType          String   @default("manual")
  previousRecordId    String?
  recordType          String
  ownershipMode       String   @default("owned")
  committeeStatus     String   @default("not_reviewed")
  entityName          String?
  entityCode          String?
  mofAssetNumber      String?
  entityAssetNumber   String?
  linkedAsset         String?
  assetDescription    String?
  accountingGroup     String?
  accountingGroupCode String?
  accountingAssetCode String?
  region              String?
  city                String?
  censusProgress      Int      @default(0)
  inventoryProgress   Int      @default(0)
  valuationProgress   Int      @default(0)
  overallProgress     Int      @default(0)
  readinessStatus     String   @default("needs_data")
  sourceFingerprint   String?
  payload             Json
  attachments         Json?
  notes               String?
  createdBy           String?
  updatedBy           String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  cycle AccountingTransformationCycle? @relation(fields: [cycleId], references: [id], onDelete: Cascade)

  @@unique([cycleId, sourceFingerprint])
  @@index([cycleId])
  @@index([stableKey])
  @@index([changeType])
  @@index([recordType])
  @@index([committeeStatus])
  @@index([readinessStatus])
  @@index([entityName])
  @@index([entityAssetNumber])
  @@index([mofAssetNumber])
  @@index([linkedAsset])
  @@index([accountingAssetCode])
  @@index([city])
  @@index([overallProgress])
  @@index([updatedAt])
}'''
if old not in s:
    raise SystemExit('AccountingTransformationRecord schema block not found')
p.write_text(s.replace(old, new))

# app.js
p = Path('src/app.js')
s = p.read_text()
s = s.replace(
    "import accountingTransformationRoutes from './routes/accounting-transformation.routes.js';",
    "import accountingTransformationRoutes from './routes/accounting-transformation.routes.js';\nimport accountingCyclesRoutes from './routes/accounting-cycles.routes.js';"
)
marker = "app.use(\n  '/api/accounting-transformation',\n  requireAuth,"
cycles = "app.use(\n  '/api/accounting-transformation/cycles',\n  requireAuth,\n  auditTrail('accounting_transformation'),\n  requirePermission('accounting_transformation'),\n  accountingCyclesRoutes\n);\n\n"
if cycles not in s:
    if marker not in s:
        raise SystemExit('Accounting route mount marker not found')
    s = s.replace(marker, cycles + marker)
p.write_text(s)

# server.js
p = Path('src/server.js')
s = p.read_text()
if 'accountingCycles.service.js' not in s:
    s = s.replace(
        "import { ensureBootstrapAdmin } from './bootstrapAdmin.js';",
        "import { ensureBootstrapAdmin } from './bootstrapAdmin.js';\nimport { ensureAccountingTransformationBaseline } from './services/accountingCycles.service.js';"
    )
if 'await ensureAccountingTransformationBaseline();' not in s:
    s = s.replace(
        '  await ensureBootstrapAdmin();\n\n  app.listen',
        '  await ensureBootstrapAdmin();\n  await ensureAccountingTransformationBaseline();\n\n  app.listen'
    )
p.write_text(s)

# accounting-transformation.routes.js
p = Path('src/routes/accounting-transformation.routes.js')
s = p.read_text()
import_marker = "} from '../config/accountingTransformation.js';\n"
service_import = "import {\n  createAccountingStableKey,\n  ensureAccountingTransformationBaseline,\n} from '../services/accountingCycles.service.js';\n"
if service_import not in s:
    s = s.replace(import_marker, import_marker + service_import)
s = s.replace('z.array(recordInputSchema).min(1).max(1500)', 'z.array(recordInputSchema).min(1).max(10000)')

old_q = "  const groupKey = normalizedText(req.query.group);\n\n  const groupWhere ="
new_q = "  const groupKey = normalizedText(req.query.group);\n  const cycleId = normalizedText(req.query.cycleId);\n  const includeHistory = String(req.query.includeHistory || '') === '1';\n  const cycleWhere = includeHistory\n    ? {}\n    : cycleId\n      ? { cycleId }\n      : { cycle: { isCurrent: true } };\n\n  const groupWhere ="
if old_q not in s:
    raise SystemExit('queryWhere marker not found')
s = s.replace(old_q, new_q)
s = s.replace(
    "  const baseFilters = {\n    ...(recordType && recordType !== 'all' ? { recordType } : {}),",
    "  const baseFilters = {\n    ...cycleWhere,\n    ...(recordType && recordType !== 'all' ? { recordType } : {}),"
)

s = s.replace(
    "router.get('/stats', async (_req, res, next) => {\n  try {",
    "router.get('/stats', async (req, res, next) => {\n  try {\n    const cycleId = normalizedText(req.query.cycleId);\n    const cycleWhere = cycleId ? { cycleId } : { cycle: { isCurrent: true } };"
)
stat_replacements = [
    ('prisma.accountingTransformationRecord.count(),', 'prisma.accountingTransformationRecord.count({ where: cycleWhere }),'),
    ("prisma.accountingTransformationRecord.count({ where: { recordType: 'land' } }),", "prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, recordType: 'land' } }),"),
    ("prisma.accountingTransformationRecord.count({ where: { recordType: 'building' } }),", "prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, recordType: 'building' } }),"),
    ('prisma.accountingTransformationRecord.count({ where: { censusProgress: 100 } }),', 'prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, censusProgress: 100 } }),'),
    ('prisma.accountingTransformationRecord.count({ where: { inventoryProgress: 100 } }),', 'prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, inventoryProgress: 100 } }),'),
    ('prisma.accountingTransformationRecord.count({ where: { valuationProgress: 100 } }),', 'prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, valuationProgress: 100 } }),'),
    ('prisma.accountingTransformationRecord.count({ where: { overallProgress: { lt: 100 } } }),', 'prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, overallProgress: { lt: 100 } } }),'),
    ("prisma.accountingTransformationRecord.count({ where: { committeeStatus: 'under_review' } }),", "prisma.accountingTransformationRecord.count({ where: { ...cycleWhere, committeeStatus: 'under_review' } }),"),
    ('prisma.accountingTransformationRecord.aggregate({\n        _avg:', 'prisma.accountingTransformationRecord.aggregate({\n        where: cycleWhere,\n        _avg:'),
]
for old_stat, new_stat in stat_replacements:
    if old_stat not in s:
        raise SystemExit(f'stats marker missing: {old_stat[:70]}')
    s = s.replace(old_stat, new_stat, 1)

# Legacy import receives the current cycle.
legacy_marker = "    const input = bulkImportSchema.parse(req.body);\n    const baseNumber = await nextRecordNumber(0);"
if legacy_marker not in s:
    raise SystemExit('legacy bulk import marker not found')
s = s.replace(
    legacy_marker,
    "    const input = bulkImportSchema.parse(req.body);\n    const currentCycle = await ensureAccountingTransformationBaseline();\n    const baseNumber = await nextRecordNumber(0);",
    1
)
s = s.replace(
    "      const existing = await prisma.accountingTransformationRecord.findUnique({\n        where: { sourceFingerprint },\n      });\n      const data = buildRecordData(item, req.authUser, { sourceFingerprint });",
    "      const stableKey = createAccountingStableKey(item.recordType, payload);\n      const existing = await prisma.accountingTransformationRecord.findFirst({\n        where: { cycleId: currentCycle.id, sourceFingerprint },\n      });\n      const data = buildRecordData(item, req.authUser, {\n        cycleId: currentCycle.id, sourceFingerprint, stableKey, changeType: 'manual',\n      });"
)

# Manual create
create_marker = "    const input = recordInputSchema.parse(req.body);\n    let record = null;\n\n    for (let attempt = 0; attempt < 5 && !record; attempt += 1) {"
if create_marker not in s:
    raise SystemExit('manual create marker not found')
s = s.replace(
    create_marker,
    "    const input = recordInputSchema.parse(req.body);\n    const currentCycle = await ensureAccountingTransformationBaseline();\n    const sourceFingerprint = createFingerprint(input.recordType, input.payload || {});\n    const stableKey = createAccountingStableKey(input.recordType, input.payload || {});\n    let record = null;\n\n    for (let attempt = 0; attempt < 5 && !record; attempt += 1) {"
)
s = s.replace(
    "            ...buildRecordData(input, req.authUser),\n            recordNumber,",
    "            ...buildRecordData(input, req.authUser, {\n              cycleId: currentCycle.id, sourceFingerprint, stableKey, changeType: 'manual',\n            }),\n            recordNumber,"
)

# Manual edit and archive protection
edit_old = """    const current = await prisma.accountingTransformationRecord.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!current) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });

    const record = await prisma.accountingTransformationRecord.update({
      where: { id: req.params.id },
      data: buildRecordData(input, req.authUser),
    });"""
edit_new = """    const current = await prisma.accountingTransformationRecord.findUnique({
      where: { id: req.params.id },
      include: { cycle: true },
    });
    if (!current) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    if (current.cycle && current.cycle.status === 'archived') {
      return res.status(409).json({ message: 'الدورات المؤرشفة للعرض التاريخي فقط ولا يمكن تعديل بياناتها' });
    }
    const sourceFingerprint = createFingerprint(input.recordType, input.payload || {});
    const stableKey = createAccountingStableKey(input.recordType, input.payload || {});

    const record = await prisma.accountingTransformationRecord.update({
      where: { id: req.params.id },
      data: buildRecordData(input, req.authUser, {
        cycleId: current.cycleId, sourceFingerprint, stableKey, changeType: current.changeType || 'manual',
      }),
    });"""
if edit_old not in s:
    raise SystemExit('manual edit marker not found')
s = s.replace(edit_old, edit_new)

delete_old = """router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.accountingTransformationRecord.delete({ where: { id: req.params.id } });"""
delete_new = """router.delete('/:id', async (req, res, next) => {
  try {
    const current = await prisma.accountingTransformationRecord.findUnique({
      where: { id: req.params.id }, include: { cycle: true },
    });
    if (!current) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    if (current.cycle && current.cycle.status === 'archived') {
      return res.status(409).json({ message: 'الدورات المؤرشفة محفوظة كسجل تاريخي ولا يمكن حذف بياناتها' });
    }
    await prisma.accountingTransformationRecord.delete({ where: { id: req.params.id } });"""
if delete_old not in s:
    raise SystemExit('delete marker not found')
s = s.replace(delete_old, delete_new)
p.write_text(s)

# Fix service selector
p = Path('src/services/accountingCycles.service.js')
s = p.read_text()
if '      changeType: true,' not in s:
    s = s.replace('      sourceFingerprint: true,\n      stableKey: true,', '      sourceFingerprint: true,\n      stableKey: true,\n      changeType: true,')
p.write_text(s)
