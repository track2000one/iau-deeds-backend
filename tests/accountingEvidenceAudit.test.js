import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNTING_CONTROL_KEY,
  EvidenceAuditConflictError,
  buildEvidenceAuditMirrorRows,
  preserveEvidenceControlForImport,
  protectEvidenceAuditPayload,
} from '../src/services/accountingEvidenceAudit.service.js';

const requirementKey = 'ownership_document';
const clientEvent = {
  id: 'ev-e2e-001',
  type: 'attachment_uploaded',
  at: '2026-09-13T05:00:00.000Z',
  actor: 'قيمة مرسلة من العميل يجب استبدالها',
  summary: 'تم رفع وربط مستند إثبات الملكية.',
};

const incomingPayload = () => ({
  G: 'عقار اختباري',
  [ACCOUNTING_CONTROL_KEY]: {
    updatedAt: '2026-09-13T05:00:00.000Z',
    evidenceChecklist: {
      [requirementKey]: {
        status: 'available',
        attachmentKey: 'doc-001',
        history: [{ ...clientEvent }],
      },
    },
  },
});

const authUser = {
  id: 'user-001',
  username: 'audit.tester',
  email: 'audit.tester@example.edu.sa',
  role: 'admin',
};

const serverRecordedAt = '2026-09-13T05:00:02.000Z';

test('E2E: event is server-stamped then converted into an AuditLog mirror row', () => {
  const protectedResult = protectEvidenceAuditPayload({}, incomingPayload(), authUser, { serverRecordedAt });

  assert.equal(protectedResult.newEvents.length, 1);
  const storedEvent = protectedResult.payload[ACCOUNTING_CONTROL_KEY]
    .evidenceChecklist[requirementKey].history[0];

  assert.equal(storedEvent.id, clientEvent.id);
  assert.equal(storedEvent.actor, authUser.username);
  assert.equal(storedEvent.actorUserId, authUser.id);
  assert.equal(storedEvent.actorEmail, authUser.email);
  assert.equal(storedEvent.actorRole, authUser.role);
  assert.equal(storedEvent.actorRoleLabel, 'مدير النظام');
  assert.equal(storedEvent.source, 'user');
  assert.equal(storedEvent.serverRecordedAt, serverRecordedAt);

  const rows = buildEvidenceAuditMirrorRows(
    { id: 'record-001', recordNumber: 'ACT-2026-000001' },
    protectedResult.payload
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].mirrorId, `record-001:${clientEvent.id}`);
  assert.equal(rows[0].data.module, 'accounting_transformation');
  assert.equal(rows[0].data.entity, 'accounting_evidence_event');
  assert.equal(rows[0].data.action, 'evidence_history_append');
  assert.equal(rows[0].data.entityId, `record-001:${clientEvent.id}`);
  assert.equal(rows[0].data.metadata.recordId, 'record-001');
  assert.equal(rows[0].data.metadata.eventId, clientEvent.id);
  assert.equal(rows[0].data.metadata.serverRecordedAt, serverRecordedAt);
  assert.equal(rows[0].data.metadata.protectedEvidenceAudit, true);
  assert.equal(rows[0].data.newData.requirementKey, requirementKey);
  assert.equal(rows[0].data.newData.actorUserId, authUser.id);
});

test('existing evidence events are immutable after server storage', () => {
  const first = protectEvidenceAuditPayload({}, incomingPayload(), authUser, { serverRecordedAt });
  const tampered = structuredClone(first.payload);
  tampered[ACCOUNTING_CONTROL_KEY].evidenceChecklist[requirementKey].history[0].summary = 'تم التلاعب بوصف الحدث.';

  assert.throws(
    () => protectEvidenceAuditPayload(first.payload, tampered, authUser),
    (error) => error instanceof EvidenceAuditConflictError
      && error.statusCode === 409
      && error.code === 'EVIDENCE_AUDIT_IMMUTABLE'
  );
});

test('existing evidence events cannot be deleted after server storage', () => {
  const first = protectEvidenceAuditPayload({}, incomingPayload(), authUser, { serverRecordedAt });
  const deletionAttempt = structuredClone(first.payload);
  deletionAttempt[ACCOUNTING_CONTROL_KEY].evidenceChecklist[requirementKey].history = [];

  assert.throws(
    () => protectEvidenceAuditPayload(first.payload, deletionAttempt, authUser),
    (error) => error instanceof EvidenceAuditConflictError && error.statusCode === 409
  );
});

test('spreadsheet imports preserve the protected server-side control history', () => {
  const first = protectEvidenceAuditPayload({}, incomingPayload(), authUser, { serverRecordedAt });
  const imported = {
    G: 'وصف محدث من ملف Excel',
    [ACCOUNTING_CONTROL_KEY]: {
      evidenceChecklist: {
        [requirementKey]: { history: [] },
      },
    },
  };

  const safe = preserveEvidenceControlForImport(first.payload, imported);
  const history = safe[ACCOUNTING_CONTROL_KEY].evidenceChecklist[requirementKey].history;

  assert.equal(safe.G, 'وصف محدث من ملف Excel');
  assert.equal(history.length, 1);
  assert.equal(history[0].id, clientEvent.id);
  assert.equal(history[0].serverRecordedAt, serverRecordedAt);
});

test('import paths can explicitly block injection of new evidence history', () => {
  assert.throws(
    () => protectEvidenceAuditPayload({}, incomingPayload(), authUser, {
      serverRecordedAt,
      allowNewEvents: false,
    }),
    (error) => error instanceof EvidenceAuditConflictError
      && error.code === 'EVIDENCE_AUDIT_IMPORT_BLOCKED'
  );
});
