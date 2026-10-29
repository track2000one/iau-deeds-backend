import { z } from 'zod';
import { prisma } from '../prisma.js';

export const normalizeDeedNumber = (value) =>
  String(value ?? '')
    .trim()
    .normalize('NFKC')
    .replace(/[\u0660-\u0669]/g, (char) => String(char.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (char) => String(char.charCodeAt(0) - 0x06f0))
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, '')
    .toUpperCase();

const text = (max = 500) => z.string().trim().max(max);
export const importRowSchema = z.object({
  code: z.string().trim().min(2).max(70).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(250),
  campus: z.string().trim().min(2).max(250),
  deedNumber: z.string().trim().min(1).max(100),
  approximateArea: z.number().finite().positive().max(1e12),
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
  sourceReference: text(250).nullable().optional(),
  notes: text(1800).nullable().optional(),
}).strict().refine((r) => (r.latitude == null) === (r.longitude == null), {
  message: 'يجب إدخال خط العرض وخط الطول معًا أو تركهما معًا',
});

export const importRequestSchema = z.object({
  rows: z.array(z.unknown()).min(1).max(100),
}).strict();

const readCandidates = async (db, rows) => {
  // The deed registry can be verified even while the VacantLand table is waiting
  // for its separately approved, backed-up production migration.
  const deeds = await db.deed.findMany({
    select: { id: true, deedNumber: true, propertyDescription: true },
  });
  let existing = [];
  let schemaReady = true;
  try {
    existing = await db.vacantLand.findMany({
      where: { code: { in: rows.map((r) => r?.code).filter((x) => typeof x === 'string') } },
      select: { id: true, code: true, deedId: true },
    });
  } catch (error) {
    // Only P2021 for the missing new table is recoverable in read-only preview.
    // Never treat a database outage, missing deed table or other Prisma failure
    // as permission to commit data without complete duplicate checks.
    if (error?.code !== 'P2021'
      || !/(?:^|[."'])VacantLand(?:$|[."'])/i.test(String(error?.meta?.table || ''))) {
      throw error;
    }
    schemaReady = false;
  }
  const deedsByKey = new Map();
  for (const deed of deeds) {
    const key = normalizeDeedNumber(deed.deedNumber);
    if (!deedsByKey.has(key)) deedsByKey.set(key, []);
    deedsByKey.get(key).push(deed);
  }
  return { schemaReady, deedsByKey,
    existingByCode: new Map(existing.map((r) => [r.code.toUpperCase(), r])) };
};
export async function previewVacantImport(body, db = prisma) {
  const { rows } = importRequestSchema.parse(body);
  const parsed = rows.map((row) => importRowSchema.safeParse(row));
  const candidates = parsed.map((r) => r.success ? r.data : null);
  const lookup = await readCandidates(db, candidates);
  const codeCounts = new Map();
  for (const row of candidates) {
    if (row) codeCounts.set(row.code, (codeCounts.get(row.code) || 0) + 1);
  }

  const result = rows.map((raw, index) => {
    const entry = parsed[index];
    if (!entry.success) {
      return {
        rowNumber: index + 1, code: String(raw?.code || ''), name: String(raw?.name || ''),
        status: 'INVALID', issues: entry.error.issues.map((issue) => issue.message),
        deedId: null, deedNumber: String(raw?.deedNumber || ''), linkedDeed: null,
      };
    }
    const row = entry.data;
    const issues = [];
    const key = normalizeDeedNumber(row.deedNumber);
    const matches = lookup.deedsByKey.get(key) || [];
    if (matches.length === 0) issues.push('رقم الصك غير موجود في السجل الموحد للصكوك');
    if (matches.length > 1) issues.push('رقم الصك ملتبس بين عدة سجلات، يلزم معالجته');
    if (codeCounts.get(row.code) > 1) issues.push('رمز الموقع مكرر داخل ملف الاستيراد');
    if (lookup.existingByCode.has(row.code)) issues.push('رمز الموقع موجود مسبقًا في الأراضي الشاغرة');
    if (!lookup.schemaReady) issues.push('جدول الأراضي الشاغرة بانتظار التهيئة؛ لا يمكن التأكد من التكرار أو حفظ الدفعة بعد');
    return {
      rowNumber: index + 1, code: row.code, name: row.name,
      campus: row.campus, approximateArea: row.approximateArea,
      deedNumber: row.deedNumber, deedId: matches.length === 1 ? matches[0].id : null,
      linkedDeed: matches.length === 1 ? {
        id: matches[0].id, deedNumber: matches[0].deedNumber,
        propertyDescription: matches[0].propertyDescription,
      } : null,
      status: issues.length ? 'BLOCKED' : 'READY', issues,
    };
  });
  return {
    total: result.length,
    schemaReady: lookup.schemaReady,
    deedMatched: result.filter((r) => r.linkedDeed !== null).length,
    ready: result.filter((r) => r.status === 'READY').length,
    blocked: result.filter((r) => r.status !== 'READY').length,
    rows: result,
  };
}

export async function commitVacantImport(body, user, db = prisma) {
  // Use a transaction and re-run preview inside it. All-or-nothing: never write
  // unmatched deeds, duplicated codes or partially reviewed batches.
  return db.$transaction(async (tx) => {
    const preview = await previewVacantImport(body, tx);
    if (preview.blocked) return { committed: false, ...preview };
    const validRows = importRequestSchema.parse(body).rows.map((r) => importRowSchema.parse(r));
    const created = [];
    for (let index = 0; index < validRows.length; index++) {
      const row = validRows[index];
      const match = preview.rows[index];
      const record = await tx.vacantLand.create({
        data: {
          code: row.code, name: row.name, campus: row.campus,
          deedId: match.deedId, approximateArea: row.approximateArea,
          latitude: row.latitude ?? null, longitude: row.longitude ?? null,
          notes: [row.notes, row.sourceReference ? 'مرجع الحصر: ' + row.sourceReference : null]
            .filter(Boolean).join('\n') || null,
          status: 'DRAFT', verifiedVacantArea: null,
          createdById: user.id, createdByName: user.username,
          updatedById: user.id, updatedByName: user.username,
        },
        select: { id: true, code: true, deedId: true },
      });
      created.push(record);
    }
    return { committed: true, count: created.length, records: created };
  }, { timeout: 30000 });
}

const allowedToView = (user, moduleNames) => user?.role === 'admin'
  || user?.permissions?.some((p) => moduleNames.includes(p.module) && p.canView);

export async function deedRelationships(deedId, user, db = prisma) {
  const deed = await db.deed.findUnique({
    where: { id: deedId },
    select: { id: true, deedNumber: true, propertyDescription: true },
  });
  if (!deed) return null;
  const buildingsVisible = allowedToView(user, ['central_buildings', 'mosques']);
  const investmentsVisible = allowedToView(user, ['investments']);
  const [buildings, sites] = await Promise.all([
    buildingsVisible
      ? db.mosqueBuilding.findMany({
          where: { deedId },
          select: { id: true, buildingNumber: true, name: true, campusLocation: true, operationalStatus: true },
          orderBy: { buildingNumber: 'asc' }, take: 200,
        })
      : Promise.resolve([]),
    investmentsVisible
      ? db.investmentSite.findMany({
          where: { OR: [{ deedId }, { deedLinks: { some: { deedId } } }] },
          select: {
            id: true, code: true, name: true,
            areas: {
              select: {
                id: true, areaCode: true, name: true, occupancyStatus: true,
                opportunities: { select: { id: true, opportunityNumber: true, title: true, status: true } },
              },
            },
          },
          orderBy: { name: 'asc' }, take: 200,
        })
      : Promise.resolve([]),
  ]);
  return {
    deed,
    permissions: { buildingsVisible, investmentsVisible },
    buildings,
    investmentSites: sites,
  };
}
