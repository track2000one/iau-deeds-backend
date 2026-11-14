import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/prisma.js';
import { signAccessToken } from '../src/security/auth.js';

/**
 * Real HTTP -> JWT -> permission middleware -> Prisma -> disposable Postgres.
 * NEVER set this flag against Railway/production or a shared database.
 */
const enabled = process.env.FOLLOW_UP_INTEGRATION_TEST === '1';
const suffix = randomUUID().slice(0, 12);
const records = [];
const users = [];
let server;
let origin;
let creator;
let assignee;
let other;
let restricted;
let administrator;
let assignedRecord;
let otherRecord;

const assertDisposableDatabase = () => {
  const raw = process.env.DATABASE_URL || '';
  let db;
  try {
    db = new URL(raw);
  } catch {
    throw new Error('Integration tests require a local disposable PostgreSQL DATABASE_URL');
  }
  assert.equal(db.protocol, 'postgresql:', 'Only local Postgres is allowed');
  assert.ok(['127.0.0.1', 'localhost'].includes(db.hostname),
    'REFUSING integration tests against non-local database');
  assert.equal(db.pathname, '/iau_deeds_integration_test',
    'REFUSING integration tests outside the dedicated iau_deeds_integration_test database');
  assert.equal(process.env.JWT_SECRET,
    'local-only-follow-up-integration-secret-2026-never-production',
    'Refusing to run with a non-test JWT secret');
};

const createUser = async (label, role, actions = {}) => {
  const row = await prisma.appUser.create({
    data: {
      username: `ci-${label}-${suffix}`,
      email: `${label}-${suffix}@example.invalid`,
      passwordHash: 'synthetic-test-only-not-a-login',
      role,
      isActive: true,
      ...(role === 'employee'
        ? { permissions: { create: { module: 'transaction_follow_up',
          canView: actions.canView ?? true,
          canAdd: actions.canAdd ?? false,
          canEdit: actions.canEdit ?? false,
          canDelete: false,
          canPrint: actions.canPrint ?? false,
          canUploadAttachments: actions.canUploadAttachments ?? false,
        } } }
        : {}),
    },
  });
  users.push(row.id);
  return row;
};

const createTransaction = async ({
  number, by, assignedTo, subject = 'معاملة تجريبية لاختبارات الصلاحيات',
}) => {
  const record = await prisma.transactionFollowUp.create({
    data: {
      trackingNumber: `CI-FOLLOW-${number}-${suffix}`,
      transactionNumber: `CI-${number}-${suffix}`,
      transactionYear: 2026,
      transactionDate: new Date('2026-11-05T09:00:00.000Z'),
      transactionDateType: 'gregorian',
      transactionDateInput: '2026-11-05',
      transactionType: 'incoming_external',
      organizationalUnit: 'endowments_properties',
      subject,
      status: 'in_progress',
      priority: 'normal',
      createdById: by.id,
      createdByName: by.username,
      currentAssigneeUserId: assignedTo.id,
      currentAssigneeName: assignedTo.username,
      assignedAt: new Date('2026-11-05T10:00:00.000Z'),
    },
  });
  records.push(record.id);
  return record;
};

const request = async (path, method = 'GET', actor = creator, body) => {
  const response = await fetch(origin + '/api/transaction-follow-up' + path, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${signAccessToken(actor)}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data };
};

if (enabled) {
  before(async () => {
    assertDisposableDatabase();
    creator = await createUser('creator', 'employee',
      { canView: true, canEdit: true, canPrint: true });
    assignee = await createUser('assignee', 'employee',
      { canView: true, canEdit: true, canUploadAttachments: true });
    other = await createUser('unrelated', 'employee',
      { canView: true, canEdit: true });
    restricted = await createUser('restricted', 'employee',
      { canView: false, canEdit: false });
    administrator = await createUser('supervisor', 'admin');

    assignedRecord = await createTransaction({
      number: 'A', by: creator, assignedTo: assignee,
    });
    otherRecord = await createTransaction({
      number: 'B', by: other, assignedTo: creator, subject: 'معاملة تجريبية ثانية',
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (records.length) await prisma.transactionFollowUp.deleteMany({
      where: { id: { in: records } },
    });
    if (users.length) await prisma.appUser.deleteMany({
      where: { id: { in: users } },
    });
    await prisma.$disconnect();
  });

  test('unauthenticated, disabled and unprivileged accounts cannot access records', async () => {
    assert.equal((await request('/', 'GET', null)).status, 401);
    assert.equal((await request('/', 'GET', restricted)).status, 403);

    await prisma.appUser.update({ where: { id: assignee.id }, data: { isActive: false } });
    try {
      assert.equal((await request('/' + assignedRecord.id, 'GET', assignee)).status, 401);
    } finally {
      await prisma.appUser.update({ where: { id: assignee.id }, data: { isActive: true } });
    }

    assert.equal((await request('/', 'POST', creator, {
      transactionNumber: 'CI-DENIED', transactionDate: '2026-11-05',
      organizationalUnit: 'endowments_properties', subject: 'مرفوض',
    })).status, 403);
  });

  test('normal employee sees only assigned transactions in list and own/assigned details', async () => {
    const list = await request('/?pageSize=30&mine=false', 'GET', assignee);
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.ok(list.data.items.some((row) => row.id === assignedRecord.id));
    assert.ok(!list.data.items.some((row) => row.id === otherRecord.id),
      'Another employee transaction must not be in assigned list');

    assert.equal((await request('/' + assignedRecord.id, 'GET', creator)).status, 200);
    assert.equal((await request('/' + assignedRecord.id, 'GET', assignee)).status, 200);
    assert.equal((await request('/' + assignedRecord.id, 'GET', other)).status, 403);
  });

  test('assignee can log an action but cannot edit the master transaction', async () => {
    const denied = await request('/' + assignedRecord.id, 'PATCH', assignee,
      { subject: 'محاولة تعديل غير مصرح بها' });
    assert.equal(denied.status, 403, JSON.stringify(denied.data));

    const action = await request('/' + assignedRecord.id + '/action', 'PATCH', assignee,
      { actionText: 'تمت المراجعة وطلب استكمال الإفادة', status: 'in_progress' });
    assert.equal(action.status, 200, JSON.stringify(action.data));
    assert.equal(action.data.lastActionByUserId, assignee.id);

    const stored = await prisma.transactionFollowUp.findUnique({
      where: { id: assignedRecord.id },
    });
    assert.equal(stored.subject, assignedRecord.subject, 'Assignee action cannot modify master subject');
    assert.equal(stored.lastActionByUserId, assignee.id);
    assert.equal(await prisma.transactionFollowUpEvent.count({
      where: { transactionId: assignedRecord.id, createdById: assignee.id },
    }), 1);
  });

  test('unrelated employee cannot edit/delete another record; creator and admin can edit', async () => {
    assert.equal((await request('/' + assignedRecord.id, 'PATCH', other,
      { subject: 'تعديل غير مصرح به' })).status, 403);
    assert.equal((await request('/' + assignedRecord.id, 'DELETE', other)).status, 403);
    assert.equal((await request('/' + assignedRecord.id, 'DELETE', creator)).status, 403);

    const ownerUpdate = await request('/' + assignedRecord.id, 'PATCH', creator,
      { subject: 'تحديث تجريبي بواسطة المنشئ' });
    assert.equal(ownerUpdate.status, 200, JSON.stringify(ownerUpdate.data));
    assert.equal(ownerUpdate.data.subject, 'تحديث تجريبي بواسطة المنشئ');

    const adminUpdate = await request('/' + otherRecord.id, 'PATCH', administrator,
      { subject: 'تحديث تجريبي بواسطة المسؤول' });
    assert.equal(adminUpdate.status, 200, JSON.stringify(adminUpdate.data));
    assert.equal(adminUpdate.data.subject, 'تحديث تجريبي بواسطة المسؤول');
  });

  test('executive report stays scoped to current employee even with forged assignee filter', async () => {
    const query = `/reports/executive?from=2026-11-01&to=2026-11-30&assigneeUserId=${creator.id}`;
    const limited = await request(query, 'GET', assignee);
    assert.equal(limited.status, 200, JSON.stringify(limited.data));
    assert.equal(limited.data.scope.assigneeUserId, assignee.id);
    assert.equal(limited.data.scope.mine, true);
    assert.equal(limited.data.summary.totalIncluded, 1);
    assert.deepEqual(limited.data.transactions.map((x) => x.id), [assignedRecord.id],
      'Report must not expose a differently assigned record');

    const allReport = await request('/reports/executive?from=2026-11-01&to=2026-11-30',
      'GET', administrator);
    assert.equal(allReport.status, 200, JSON.stringify(allReport.data));
    assert.equal(allReport.data.scope.assigneeUserId, null);
    const ids = allReport.data.transactions.map((item) => item.id);
    assert.ok(ids.includes(assignedRecord.id));
    assert.ok(ids.includes(otherRecord.id));
  });

  test('only supervisor can delete transaction and removal is persisted', async () => {
    const deleted = await request('/' + otherRecord.id, 'DELETE', administrator);
    assert.equal(deleted.status, 204, JSON.stringify(deleted.data));
    assert.equal(await prisma.transactionFollowUp.count({
      where: { id: otherRecord.id },
    }), 0);
  });
} else {
  test('follow-up integration requires an isolated local PostgreSQL database',
    { skip: true }, () => {});
}
