import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTING_CONTROL_KEY, buildEvidenceAuditMirrorRows } from '../src/services/accountingEvidenceAudit.service.js';
import { reconcileEvidenceAuditMirror } from '../src/services/accountingEvidenceAuditReconciliation.service.js';

const record = {
  id: 'record-reconcile-001',
  recordNumber: 'ACT-2026-000777',
  payload: {
    [ACCOUNTING_CONTROL_KEY]: {
      evidenceChecklist: {
        ownership_document: {
          status: 'available',
          history: [{
            id: 'ev-reconcile-001',
            type: 'attachment_uploaded',
            at: '2026-09-13T06:00:00.000Z',
            actor: 'audit.admin',
            actorUserId: 'user-admin',
            actorEmail: 'audit.admin@example.edu.sa',
            actorRole: 'admin',
            actorRoleLabel: 'مدير النظام',
            actorContext: 'لجنة متابعة متطلبات التحول المحاسبي',
            source: 'user',
            summary: 'تم رفع مستند إثبات الملكية.',
            serverRecordedAt: '2026-09-13T06:00:02.000Z',
          }],
        },
      },
    },
  },
};

const expectedMirror = buildEvidenceAuditMirrorRows(record, record.payload)[0];

const makeDb = ({ existing = [], auditOnly = [], createCount } = {}) => {
  let recordCalls = 0;
  let auditScanCalls = 0;
  const created = [];
  return {
    created,
    accountingTransformationRecord: {
      findMany: async () => {
        recordCalls += 1;
        return recordCalls === 1 ? [record] : [];
      },
    },
    auditLog: {
      findMany: async (args) => {
        const ids = args?.where?.entityId?.in;
        if (Array.isArray(ids)) return existing.filter((item) => ids.includes(item.entityId));
        auditScanCalls += 1;
        return auditScanCalls === 1 ? [...existing, ...auditOnly] : [];
      },
      createMany: async ({ data }) => {
        created.push(...data);
        return { count: createCount ?? data.length };
      },
    },
  };
};

const storedMirror = (overrides = {}) => ({
  id: 'audit-log-001',
  ...expectedMirror.data,
  createdAt: new Date('2026-09-13T06:00:03.000Z'),
  ...overrides,
});

test('reconciliation reports a missing mirror without mutating AuditLog in dry-run mode', async () => {
  const db = makeDb();
  const result = await reconcileEvidenceAuditMirror(db, { detailLimit: 20 });

  assert.equal(result.recordsScanned, 1);
  assert.equal(result.expectedEvents, 1);
  assert.equal(result.verified, 0);
  assert.equal(result.missingBeforeRepair, 1);
  assert.equal(result.repaired, 0);
  assert.equal(result.remainingMissing, 1);
  assert.equal(result.status, 'needs_attention');
  assert.equal(db.created.length, 0);
  assert.equal(result.details[0].status, 'missing_mirror');
  assert.equal(result.details[0].mirrorId, expectedMirror.mirrorId);
});

test('safe backfill creates only the missing mirror and leaves no remaining missing item', async () => {
  const db = makeDb();
  const result = await reconcileEvidenceAuditMirror(db, { repairMissing: true, detailLimit: 20 });

  assert.equal(result.missingBeforeRepair, 1);
  assert.equal(result.repaired, 1);
  assert.equal(result.remainingMissing, 0);
  assert.equal(result.mismatched, 0);
  assert.equal(result.status, 'ok');
  assert.equal(db.created.length, 1);
  assert.deepEqual(db.created[0], expectedMirror.data);
});

test('mismatched mirrors are flagged for manual review and never overwritten automatically', async () => {
  const db = makeDb({
    existing: [storedMirror({ description: 'وصف مختلف لا يجوز استبداله تلقائيًا.' })],
  });
  const result = await reconcileEvidenceAuditMirror(db, { repairMissing: true, detailLimit: 20 });

  assert.equal(result.missingBeforeRepair, 0);
  assert.equal(result.repaired, 0);
  assert.equal(result.mismatched, 1);
  assert.equal(result.status, 'needs_attention');
  assert.equal(db.created.length, 0);
  assert.equal(result.details[0].status, 'mismatch');
  assert.ok(result.details[0].fields.includes('description'));
});

test('AuditLog-only rows are retained as historical rows and reported separately', async () => {
  const orphan = {
    id: 'audit-orphan-001',
    entityId: 'deleted-record:ev-old-001',
    entityLabel: 'سجل تاريخي',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
  const db = makeDb({ existing: [storedMirror()], auditOnly: [orphan] });
  const result = await reconcileEvidenceAuditMirror(db, { detailLimit: 20 });

  assert.equal(result.verified, 1);
  assert.equal(result.missingBeforeRepair, 0);
  assert.equal(result.mismatched, 0);
  assert.equal(result.auditOnly, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.auditOnlyDetails[0].mirrorId, orphan.entityId);
});
