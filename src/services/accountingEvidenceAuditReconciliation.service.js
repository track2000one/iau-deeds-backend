import { isDeepStrictEqual } from 'node:util';
import { buildEvidenceAuditMirrorRows } from './accountingEvidenceAudit.service.js';

const chunk = (items, size) => {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
};

const mirrorFields = [
  'userId',
  'username',
  'userEmail',
  'userRole',
  'action',
  'module',
  'entity',
  'entityId',
  'entityLabel',
  'status',
  'description',
  'newData',
  'metadata',
];

const normalizeMirror = (value) => {
  const normalized = {};
  for (const key of mirrorFields) normalized[key] = value?.[key] ?? null;
  return normalized;
};

const mismatchFields = (expected, actual) => mirrorFields.filter(
  (key) => !isDeepStrictEqual(expected?.[key] ?? null, actual?.[key] ?? null)
);

export const reconcileEvidenceAuditMirror = async (db, options = {}) => {
  const batchSize = Math.min(1000, Math.max(50, Number(options.batchSize) || 250));
  const detailLimit = Math.min(2000, Math.max(0, Number(options.detailLimit) || 250));
  const repairMissing = options.repairMissing === true;

  let cursor = null;
  let recordsScanned = 0;
  let expectedEvents = 0;
  let verified = 0;
  let missing = 0;
  let mismatched = 0;
  let repaired = 0;
  const expectedIds = new Set();
  const details = [];

  const pushDetail = (detail) => {
    if (details.length < detailLimit) details.push(detail);
  };

  for (;;) {
    const records = await db.accountingTransformationRecord.findMany({
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, recordNumber: true, payload: true },
    });
    if (!records.length) break;

    recordsScanned += records.length;
    cursor = records[records.length - 1].id;

    const rows = records.flatMap((record) => buildEvidenceAuditMirrorRows(record, record.payload || {}).map((row) => ({
      ...row,
      recordId: record.id,
      recordNumber: record.recordNumber || null,
    })));
    if (!rows.length) continue;

    expectedEvents += rows.length;
    rows.forEach((row) => expectedIds.add(row.mirrorId));

    const existing = [];
    for (const ids of chunk(rows.map((row) => row.mirrorId), 500)) {
      existing.push(...await db.auditLog.findMany({
        where: {
          module: 'accounting_transformation',
          entity: 'accounting_evidence_event',
          action: 'evidence_history_append',
          entityId: { in: ids },
        },
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
      }));
    }

    const existingById = new Map(existing.map((item) => [item.entityId, item]));
    const missingRows = [];

    for (const row of rows) {
      const actual = existingById.get(row.mirrorId);
      if (!actual) {
        missing += 1;
        missingRows.push(row);
        pushDetail({
          status: 'missing_mirror',
          recordId: row.recordId,
          recordNumber: row.recordNumber,
          eventId: row.data?.metadata?.eventId || null,
          requirementKey: row.data?.metadata?.requirementKey || null,
          mirrorId: row.mirrorId,
        });
        continue;
      }

      const expected = normalizeMirror(row.data);
      const current = normalizeMirror(actual);
      const differences = mismatchFields(expected, current);
      if (differences.length) {
        mismatched += 1;
        pushDetail({
          status: 'mismatch',
          recordId: row.recordId,
          recordNumber: row.recordNumber,
          eventId: row.data?.metadata?.eventId || null,
          requirementKey: row.data?.metadata?.requirementKey || null,
          mirrorId: row.mirrorId,
          auditLogId: actual.id,
          serverCreatedAt: actual.createdAt,
          fields: differences,
        });
      } else {
        verified += 1;
      }
    }

    if (repairMissing && missingRows.length) {
      for (const group of chunk(missingRows.map((row) => row.data), 500)) {
        const result = await db.auditLog.createMany({ data: group });
        repaired += Number(result?.count ?? group.length);
      }
    }
  }

  const auditOnly = [];
  let auditOnlyCount = 0;
  let auditCursor = null;
  for (;;) {
    const rows = await db.auditLog.findMany({
      where: {
        module: 'accounting_transformation',
        entity: 'accounting_evidence_event',
        action: 'evidence_history_append',
      },
      orderBy: { id: 'asc' },
      take: 1000,
      ...(auditCursor ? { cursor: { id: auditCursor }, skip: 1 } : {}),
      select: { id: true, entityId: true, entityLabel: true, createdAt: true },
    });
    if (!rows.length) break;
    auditCursor = rows[rows.length - 1].id;
    for (const row of rows) {
      if (!expectedIds.has(row.entityId)) {
        auditOnlyCount += 1;
        if (auditOnly.length < detailLimit) {
          auditOnly.push({
            auditLogId: row.id,
            mirrorId: row.entityId,
            entityLabel: row.entityLabel,
            serverCreatedAt: row.createdAt,
          });
        }
      }
    }
  }

  const remainingMissing = Math.max(0, missing - repaired);
  return {
    checkedAt: new Date().toISOString(),
    repairMissing,
    recordsScanned,
    expectedEvents,
    verified,
    missingBeforeRepair: missing,
    repaired,
    remainingMissing,
    mismatched,
    auditOnly: auditOnlyCount,
    status: remainingMissing === 0 && mismatched === 0 ? 'ok' : 'needs_attention',
    details,
    auditOnlyDetails: auditOnly,
    notes: {
      auditOnly: 'سجلات موجودة في AuditLog دون حدث مقابل في السجل الحالي. تُحفظ كسجل تاريخي ولا يتم حذفها أو تعديلها تلقائيًا.',
      mismatch: 'الاختلافات لا تُصحح تلقائيًا حفاظًا على سلامة السجل الرقابي؛ تحتاج مراجعة يدوية.',
    },
  };
};
