from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)

service = Path('src/services/accountingEvidenceAudit.service.js')
text = service.read_text(encoding='utf-8')
needle = """export const buildEvidenceAuditMirrorRows = (record, payload = {}) =>
  listEvidenceAuditEvents(payload).map(({ requirementKey, event }) => ({
    mirrorId: `${record.id}:${event.id}`,
    data: {
      userId: event.actorUserId || null,
      username: event.actor || null,
      userEmail: event.actorEmail || null,
      userRole: event.actorRole || null,
      action: 'evidence_history_append',
      module: 'accounting_transformation',
      entity: 'accounting_evidence_event',
      entityId: `${record.id}:${event.id}`,
      entityLabel: `${record.recordNumber || record.id} · ${requirementKey}`,
      status: 'success',
      description: String(event.summary || 'حدث في سجل مستندات الإثبات').slice(0, 5000),
      newData: { ...cloneJson(event), requirementKey },
      metadata: {
        recordId: record.id,
        recordNumber: record.recordNumber || null,
        requirementKey,
        eventId: event.id,
        eventAt: event.at || null,
        serverRecordedAt: event.serverRecordedAt || null,
        source: event.source || null,
        protectedEvidenceAudit: true,
      },
    },
  }));
"""
addition = needle + """

/**
 * Backfills the append-only AuditLog mirror for histories that existed before
 * server-side enforcement was deployed. It is idempotent at application level:
 * mirror IDs are checked before insert and no existing audit row is updated.
 */
export const backfillEvidenceAuditMirror = async (db, options = {}) => {
  const batchSize = Math.min(1000, Math.max(50, Number(options.batchSize) || 250));
  let cursor = null;
  let scanned = 0;
  let mirrored = 0;

  for (;;) {
    const records = await db.accountingTransformationRecord.findMany({
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, recordNumber: true, payload: true },
    });
    if (!records.length) break;
    scanned += records.length;
    cursor = records[records.length - 1].id;

    const rows = records.flatMap((record) => buildEvidenceAuditMirrorRows(record, record.payload || {}));
    if (!rows.length) continue;

    const existingIds = new Set();
    for (let index = 0; index < rows.length; index += 500) {
      const ids = rows.slice(index, index + 500).map((item) => item.mirrorId);
      const existing = await db.auditLog.findMany({
        where: {
          module: 'accounting_transformation',
          entity: 'accounting_evidence_event',
          entityId: { in: ids },
        },
        select: { entityId: true },
      });
      existing.forEach((item) => existingIds.add(item.entityId));
    }

    const missing = rows.filter((item) => !existingIds.has(item.mirrorId)).map((item) => item.data);
    for (let index = 0; index < missing.length; index += 500) {
      const chunk = missing.slice(index, index + 500);
      if (chunk.length) {
        const result = await db.auditLog.createMany({ data: chunk });
        mirrored += Number(result?.count || chunk.length);
      }
    }
  }

  return { scanned, mirrored };
};
"""
text = replace_once(text, needle, addition, 'append audit backfill helper')
service.write_text(text, encoding='utf-8')

server = Path('src/server.js')
text = server.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import { archiveOrphanedMosqueLeaves } from './services/mosqueLeaveLifecycle.service.js';\n",
    "import { archiveOrphanedMosqueLeaves } from './services/mosqueLeaveLifecycle.service.js';\nimport { backfillEvidenceAuditMirror } from './services/accountingEvidenceAudit.service.js';\nimport { prisma } from './prisma.js';\n",
    'server audit backfill import',
)
text = replace_once(
    text,
    "  await ensureAccountingTransformationBaseline();\n\n  app.listen(port, () => {\n",
    "  await ensureAccountingTransformationBaseline();\n  try {\n    const auditBackfill = await backfillEvidenceAuditMirror(prisma);\n    if (auditBackfill.mirrored > 0) {\n      console.log(`Mirrored ${auditBackfill.mirrored} protected accounting evidence audit events.`);\n    }\n  } catch (error) {\n    console.error('Unable to backfill protected accounting evidence audit events:', error);\n  }\n\n  app.listen(port, () => {\n",
    'server audit backfill startup',
)
server.write_text(text, encoding='utf-8')
print('Applied evidence audit mirror backfill.')
