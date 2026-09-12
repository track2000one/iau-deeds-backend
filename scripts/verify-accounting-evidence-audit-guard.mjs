import assert from 'node:assert/strict';
import {
  ACCOUNTING_CONTROL_KEY,
  EvidenceAuditConflictError,
  hasProtectedEvidenceHistory,
  preserveEvidenceControlForImport,
  protectEvidenceAuditPayload,
} from '../src/services/accountingEvidenceAudit.service.js';

const user = { id: 'u-1', username: 'tester', email: 'tester@iau.edu.sa', role: 'employee' };
const oldEvent = {
  id: 'ev-old',
  type: 'created',
  at: '2026-09-01T08:00:00.000Z',
  actor: 'old-user',
  source: 'user',
  summary: 'حدث محفوظ مسبقًا',
};
const previousPayload = {
  A: 'value',
  [ACCOUNTING_CONTROL_KEY]: {
    responsible: 'الإدارة المالية',
    evidenceChecklist: {
      deed: { status: 'missing', history: [oldEvent] },
    },
  },
};

const assertConflict = (fn, label) => {
  assert.throws(fn, (error) => error instanceof EvidenceAuditConflictError && error.statusCode === 409, label);
};

// Exact old history + one fresh event is accepted; actor fields are server-owned.
{
  const incoming = structuredClone(previousPayload);
  incoming[ACCOUNTING_CONTROL_KEY].evidenceChecklist.deed.history.push({
    id: 'ev-new',
    type: 'note',
    at: '2026-09-12T18:00:00.000Z',
    actor: 'spoofed-user',
    actorEmail: 'spoof@example.com',
    source: 'system',
    summary: 'متابعة جديدة',
  });
  const result = protectEvidenceAuditPayload(previousPayload, incoming, user, {
    serverRecordedAt: '2026-09-12T19:00:00.000Z',
  });
  const history = result.payload[ACCOUNTING_CONTROL_KEY].evidenceChecklist.deed.history;
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], oldEvent);
  assert.equal(history[1].actor, 'tester');
  assert.equal(history[1].actorUserId, 'u-1');
  assert.equal(history[1].actorEmail, 'tester@iau.edu.sa');
  assert.equal(history[1].actorRole, 'employee');
  assert.equal(history[1].source, 'user');
  assert.equal(history[1].serverRecordedAt, '2026-09-12T19:00:00.000Z');
  assert.equal(result.newEvents.length, 1);
}

// Removing an existing history event is rejected.
{
  const incoming = structuredClone(previousPayload);
  incoming[ACCOUNTING_CONTROL_KEY].evidenceChecklist.deed.history = [];
  assertConflict(() => protectEvidenceAuditPayload(previousPayload, incoming, user), 'deletion must be rejected');
}

// Mutating an existing history event is rejected.
{
  const incoming = structuredClone(previousPayload);
  incoming[ACCOUNTING_CONTROL_KEY].evidenceChecklist.deed.history[0].summary = 'تم التلاعب';
  assertConflict(() => protectEvidenceAuditPayload(previousPayload, incoming, user), 'mutation must be rejected');
}

// Duplicate new event IDs are rejected, including across requirements.
{
  const incoming = structuredClone(previousPayload);
  incoming[ACCOUNTING_CONTROL_KEY].evidenceChecklist.deed.history.push({ id: 'dup', type: 'note', at: '2026-09-12T18:00:00Z', summary: 'أ' });
  incoming[ACCOUNTING_CONTROL_KEY].evidenceChecklist.other = {
    status: 'missing',
    history: [{ id: 'dup', type: 'note', at: '2026-09-12T18:00:00Z', summary: 'ب' }],
  };
  assertConflict(() => protectEvidenceAuditPayload(previousPayload, incoming, user), 'duplicate id must be rejected');
}

// Omitting the entire protected section preserves the server copy.
{
  const result = protectEvidenceAuditPayload(previousPayload, { A: 'changed' }, user);
  assert.deepEqual(result.payload[ACCOUNTING_CONTROL_KEY], previousPayload[ACCOUNTING_CONTROL_KEY]);
  assert.equal(result.newEvents.length, 0);
}

// Import paths cannot overwrite or inject the control-analysis/audit section.
{
  const maliciousIncoming = {
    A: 'new excel value',
    [ACCOUNTING_CONTROL_KEY]: { evidenceChecklist: { deed: { history: [] } } },
  };
  const preserved = preserveEvidenceControlForImport(previousPayload, maliciousIncoming);
  assert.deepEqual(preserved[ACCOUNTING_CONTROL_KEY], previousPayload[ACCOUNTING_CONTROL_KEY]);
  const stripped = preserveEvidenceControlForImport({}, maliciousIncoming);
  assert.equal(Object.hasOwn(stripped, ACCOUNTING_CONTROL_KEY), false);
}

assert.equal(hasProtectedEvidenceHistory(previousPayload), true);
assert.equal(hasProtectedEvidenceHistory({ A: 1 }), false);
console.log('Accounting evidence audit guard verification passed.');
