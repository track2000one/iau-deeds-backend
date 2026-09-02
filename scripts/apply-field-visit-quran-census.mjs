import fs from 'node:fs';

const routePath = 'src/routes/mosques.routes.js';
const schemaPath = 'prisma/schema.prisma';

let routes = fs.readFileSync(routePath, 'utf8');
let schema = fs.readFileSync(schemaPath, 'utf8');

const replaceOnce = (source, from, to, label) => {
  if (!source.includes(from)) throw new Error(`Missing anchor: ${label}`);
  return source.replace(from, to);
};

schema = replaceOnce(
  schema,
  '  resolutionNote    String?\n  beforeImages      Json?\n',
  '  resolutionNote    String?\n  details           Json?\n  beforeImages      Json?\n',
  'MosqueFieldVisitItem.details',
);

routes = replaceOnce(
  routes,
  "  ['المصاحف', 'سلامة المصاحف والتحقق من جهة الطباعة'],\n  ['المصاحف', 'كفاية أعداد المصاحف وملاءمة أحجامها'],",
  "  ['المصاحف', 'سلامة المصاحف والتحقق من جهة الطباعة وكفاية الأعداد وملاءمة الأحجام'],",
  'merge Quran checklist items',
);

routes = replaceOnce(
  routes,
  "  resolutionNote: z.string().trim().max(5000).optional().nullable(),\n  beforeImages: z.array(fieldVisitImageSchema).optional().default([]),",
  "  resolutionNote: z.string().trim().max(5000).optional().nullable(),\n  details: z.any().optional().nullable(),\n  beforeImages: z.array(fieldVisitImageSchema).optional().default([]),",
  'fieldVisitItemSchema.details',
);

routes = replaceOnce(
  routes,
  "  resolutionNote: item.resolutionNote || null,\n  beforeImages: item.beforeImages || [],",
  "  resolutionNote: item.resolutionNote || null,\n  details: item.details || null,\n  beforeImages: item.beforeImages || [],",
  'fieldVisitItemData.details',
);

routes = replaceOnce(
  routes,
  "const validateFieldVisitTreatmentEvidence = (input) => {\n  const requiresBeforeEvidence = ['completed', 'follow_up', 'closed'].includes(input.workflowStatus);\n  for (const item of input.items || []) {\n    if (item.status !== 'needs_action') continue;",
  "const STRUCTURED_EVIDENCE_ITEM_TITLES = new Set([\n  'اعتماد حلقات التحفيظ والمحاضرات والأنشطة القائمة',\n  'سلامة المصاحف والتحقق من جهة الطباعة وكفاية الأعداد وملاءمة الأحجام',\n  'سلامة المصاحف والتحقق من جهة الطباعة',\n  'كفاية أعداد المصاحف وملاءمة أحجامها',\n]);\n\nconst validateFieldVisitTreatmentEvidence = (input) => {\n  const requiresBeforeEvidence = ['completed', 'follow_up', 'closed'].includes(input.workflowStatus);\n  for (const item of input.items || []) {\n    if (item.status !== 'needs_action') continue;\n    const usesStructuredEvidence = STRUCTURED_EVIDENCE_ITEM_TITLES.has(item.title);",
  'structured evidence validation',
);

routes = replaceOnce(
  routes,
  "    if (requiresBeforeEvidence && !(item.beforeImages || []).length) {",
  "    if (requiresBeforeEvidence && !usesStructuredEvidence && !(item.beforeImages || []).length) {",
  'before evidence exemption',
);

routes = replaceOnce(
  routes,
  "    if (item.resolutionStatus === 'closed' && !(item.afterImages || []).length) {",
  "    if (item.resolutionStatus === 'closed' && !usesStructuredEvidence && !(item.afterImages || []).length) {",
  'after evidence exemption',
);

routes = replaceOnce(
  routes,
  "router.get('/quran-stock/opening-baseline', requireRoles('head'), async (_req, res, next) => {",
  "router.get('/quran-stock/opening-baseline', requireRoles('head', 'supervisor'), async (_req, res, next) => {",
  'baseline GET roles',
);

routes = replaceOnce(
  routes,
  "router.post('/quran-stock/opening-baseline', requireRoles('head'), async (req, res, next) => {\n  try {\n    const currentState = await getQuranOpeningBaselineState();",
  "router.post('/quran-stock/opening-baseline', requireRoles('head', 'supervisor'), async (req, res, next) => {\n  try {\n    const currentState = await getQuranOpeningBaselineState();",
  'baseline POST roles',
);

routes = replaceOnce(
  routes,
  "    const input = quranOpeningBaselineSchema.parse(req.body || {});\n    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true, name: true } });",
  "    const input = quranOpeningBaselineSchema.parse(req.body || {});\n    if (req.mosqueRole?.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, req.mosqueRole);\n    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true, name: true } });",
  'baseline supervisor site access',
);

fs.writeFileSync(schemaPath, schema);
fs.writeFileSync(routePath, routes);
console.log('Applied Quran field visit census backend patch.');
