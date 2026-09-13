import fs from 'node:fs';

const path = 'src/routes/accounting-transformation.routes.js';
let text = fs.readFileSync(path, 'utf8');

if (text.includes("router.get('/evidence-audit-log'")) {
  console.log('Evidence audit read API already present.');
  process.exit(0);
}

const anchor = "router.get('/', async (req, res, next) => {";
if (!text.includes(anchor)) throw new Error('Could not find accounting transformation list route anchor.');

const block = String.raw`
const evidenceAuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  all: z.union([z.literal('1'), z.literal('0')]).optional(),
  search: z.string().trim().max(250).optional(),
  recordId: z.string().trim().max(220).optional(),
  eventId: z.string().trim().max(220).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

router.get('/evidence-audit-log', async (req, res, next) => {
  try {
    const query = evidenceAuditQuerySchema.parse(req.query);
    const all = query.all === '1';
    const limit = all ? 10000 : query.limit;
    const clauses = [
      { module: 'accounting_transformation' },
      { entity: 'accounting_evidence_event' },
      { action: 'evidence_history_append' },
    ];

    if (query.recordId) clauses.push({ entityId: { startsWith: \`\${query.recordId}:\` } });
    if (query.eventId) clauses.push({ entityId: { endsWith: \`:\${query.eventId}\` } });
    if (query.search) {
      clauses.push({ OR: [
        { entityLabel: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { username: { contains: query.search, mode: 'insensitive' } },
        { userEmail: { contains: query.search, mode: 'insensitive' } },
      ] });
    }

    if (query.from || query.to) {
      const createdAt = {};
      if (query.from) {
        const from = new Date(\`\${query.from}T00:00:00.000Z\`);
        if (!Number.isNaN(from.getTime())) createdAt.gte = from;
      }
      if (query.to) {
        const to = new Date(\`\${query.to}T23:59:59.999Z\`);
        if (!Number.isNaN(to.getTime())) createdAt.lte = to;
      }
      if (Object.keys(createdAt).length) clauses.push({ createdAt });
    }

    const where = { AND: clauses };
    const [total, items] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: all ? 0 : (query.page - 1) * query.limit,
        take: limit,
        select: {
          id: true,
          userId: true,
          username: true,
          userEmail: true,
          userRole: true,
          action: true,
          module: true,
          entity: true,
          entityId: true,
          entityLabel: true,
          status: true,
          description: true,
          newData: true,
          metadata: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({
      items,
      page: all ? 1 : query.page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      truncated: all && total > limit,
      readOnly: true,
      source: 'server_audit_log',
    });
  } catch (error) { next(error); }
});

`;

text = text.replace(anchor, block + anchor);
fs.writeFileSync(path, text);
console.log('Evidence audit read API inserted.');
