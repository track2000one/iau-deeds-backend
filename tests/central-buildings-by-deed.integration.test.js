import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/prisma.js';
import { signAccessToken } from '../src/security/auth.js';

// This is deliberately opt-in and must only run against the disposable GitHub
// Actions PostgreSQL service. It never connects to Railway production.
const enabled = process.env.CENTRAL_BUILDINGS_INTEGRATION_TEST === '1';
const suffix = randomUUID().slice(0, 12).toUpperCase();
let server;
let baseUrl;
let owner;
const deeds = [];
const buildings = [];

function assertSafeDatabase() {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname),
    'Refusing to alter a non-local database');
  assert.equal(url.pathname, '/iau_deeds_integration_test',
    'Refusing to alter a database other than iau_deeds_integration_test');
  assert.equal(process.env.JWT_SECRET,
    'local-only-follow-up-integration-secret-2026-never-production');
}

async function request(path, method, payload) {
  const response = await fetch(baseUrl + '/api/mosques' + path, {
    method,
    headers: {
      authorization: 'Bearer ' + signAccessToken(owner),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

const input = (buildingNumber, deedId, name = 'معهد الأبحاث والاستشارات الطبية') =>
  ({ buildingNumber, deedId, name, city: 'الدمام' });

if (enabled) {
  before(async () => {
    assertSafeDatabase();
    const first = await prisma.deed.create({
      data: {
        deedNumber: 'BUILD-TEST-DEED-A-' + suffix,
        propertyDescription: 'صك تجريبي أول',
        usageType: 'other',
        area: 5000,
      },
    });
    const second = await prisma.deed.create({
      data: {
        deedNumber: 'BUILD-TEST-DEED-B-' + suffix,
        propertyDescription: 'صك تجريبي ثانٍ',
        usageType: 'other',
        area: 8000,
      },
    });
    deeds.push(first, second);
    owner = await prisma.appUser.create({
      data: {
        username: 'building-test-' + suffix,
        email: 'buildings-' + suffix + '@example.invalid',
        passwordHash: 'synthetic-test-only-not-a-login',
        isActive: true,
        role: 'employee',
        permissions: {
          create: {
            module: 'central_buildings',
            canView: true, canAdd: true, canEdit: true, canDelete: false,
            canPrint: true, canUploadAttachments: false,
          },
        },
      },
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (buildings.length) await prisma.mosqueBuilding.deleteMany({
      where: { id: { in: buildings.map((item) => item.id) } },
    });
    if (owner) {
      await prisma.userPermission.deleteMany({ where: { userId: owner.id } });
      await prisma.appUser.delete({ where: { id: owner.id } });
    }
    for (const deed of deeds) await prisma.deed.delete({ where: { id: deed.id } });
    await prisma.$disconnect();
  });

  test('the same building number and name may belong to two different deeds', async () => {
    const number = 'A70-' + suffix;
    const one = await request('/buildings', 'POST', input(number, deeds[0].id));
    assert.equal(one.status, 201, JSON.stringify(one.body));
    buildings.push(one.body);
    const two = await request('/buildings', 'POST', input(number, deeds[1].id));
    assert.equal(two.status, 201, JSON.stringify(two.body));
    buildings.push(two.body);
    assert.notEqual(one.body.id, two.body.id);
    assert.equal(one.body.buildingNumber, two.body.buildingNumber);
    assert.equal(one.body.name, two.body.name);
    assert.notEqual(one.body.deedId, two.body.deedId);

    const stored = await prisma.mosqueBuilding.findMany({
      where: { buildingNumber: number },
    });
    assert.equal(stored.length, 2);
    assert.deepEqual(new Set(stored.map((item) => item.deedId)),
      new Set(deeds.map((deed) => deed.id)));
  });

  test('read-only number lookup lists both deed links before save, without any private fields', async () => {
    const number = buildings[0].buildingNumber;
    const lookup = await request('/buildings/number-usage?number=' + encodeURIComponent(number), 'GET');
    assert.equal(lookup.status, 200, JSON.stringify(lookup.body));
    assert.equal(lookup.body.matches.length, 2);
    const ids = lookup.body.matches.map((item) => item.deedId);
    assert.deepEqual(new Set(ids), new Set(deeds.map((deed) => deed.id)));
    assert.ok(lookup.body.matches.every((item) => item.deed?.deedNumber));
    assert.ok(lookup.body.matches.every((item) => !('createdBy' in item)));
    assert.ok(lookup.body.matches.every((item) => !('photos' in item)));
    assert.ok(lookup.body.matches.every((item) => !('documents' in item)));
    assert.equal(lookup.body.truncated, false);

    const insensitive = await request('/buildings/number-usage?number=' + encodeURIComponent(number.toLowerCase()), 'GET');
    assert.equal(insensitive.status, 200);
    assert.equal(insensitive.body.matches.length, 2);
    const missing = await request('/buildings/number-usage', 'GET');
    assert.equal(missing.status, 400);
    const denied = await fetch(baseUrl + '/api/mosques/buildings/number-usage?number=' +
      encodeURIComponent(number));
    assert.equal(denied.status, 401, 'An unauthenticated caller may not enumerate building/deed links');
    const noHits = await request('/buildings/number-usage?number=CI-NONEXISTENT-' + suffix, 'GET');
    assert.equal(noHits.status, 200);
    assert.deepEqual(noHits.body.matches, []);
  });

  test('creating a repeated number within the same deed returns a meaningful conflict', async () => {
    const number = buildings[0].buildingNumber;
    const duplicate = await request('/buildings', 'POST',
      input(number, deeds[0].id, 'اسم آخر لا يبيح التكرار'));
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.match(duplicate.body.message, /ضمن الصك المحدد/);
    const differentCase = await request('/buildings', 'POST',
      input(number.toLowerCase(), deeds[0].id));
    assert.equal(differentCase.status, 409);

    const list = await prisma.mosqueBuilding.findMany({ where: {
      deedId: deeds[0].id, buildingNumber: { equals: number, mode: 'insensitive' },
    } });
    assert.equal(list.length, 1);
  });

  test('an edit cannot move a duplicate number into an occupied deed', async () => {
    const [first, second] = buildings;
    const forbidden = await request('/buildings/' + second.id, 'PUT',
      input(first.buildingNumber, first.deedId));
    assert.equal(forbidden.status, 409, JSON.stringify(forbidden.body));
    const unchanged = await prisma.mosqueBuilding.findUnique({ where: { id: second.id } });
    assert.equal(unchanged.deedId, second.deedId);

    // Updating its own record is allowed; conflict checks exclude the same ID.
    const allowed = await request('/buildings/' + second.id, 'PUT',
      input(second.buildingNumber, second.deedId, 'تحديث اسم المبنى التجريبي'));
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.id, second.id);
    assert.equal(allowed.body.name, 'تحديث اسم المبنى التجريبي');
  });

  test('normal buildings without a registered deed remain invalid', async () => {
    const denied = await request('/buildings', 'POST',
      input('A71-' + suffix, null));
    assert.equal(denied.status, 400);
  });

  test('different whitespace/case forms become one stored identifier and block same-deed repeats', async () => {
    const number = 'A70-' + suffix;
    const fresh = await request('/buildings', 'POST', input(' A 70 - ' + suffix, deeds[0].id));
    assert.equal(fresh.status, 409, JSON.stringify(fresh.body));
    assert.match(fresh.body.message, /المسافات/);

    const lookup = await request('/buildings/number-usage?number=' +
      encodeURIComponent('a 70 - ' + suffix), 'GET');
    assert.equal(lookup.status, 200, JSON.stringify(lookup.body));
    assert.equal(lookup.body.buildingNumber, number);
    assert.equal(lookup.body.matches.length, 2);

    const arabicNumerals = await request('/buildings', 'POST',
      input('a٧٠-' + suffix, deeds[0].id));
    assert.equal(arabicNumerals.status, 409);
  });

  test('legacy pre-normalization numbers are detected without rewriting past rows', async () => {
    const oldNumber = 'LEGACY70-' + suffix;
    const first = await request('/buildings', 'POST', input(oldNumber, deeds[0].id));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    buildings.push(first.body);
    const originalStoredVariant = ' L E G A C Y 70 - ' + suffix;
    await prisma.mosqueBuilding.update({
      where: { id: first.body.id },
      data: { buildingNumber: originalStoredVariant },
    });
    const lookup = await request('/buildings/number-usage?number=' +
      encodeURIComponent('legacy70-' + suffix), 'GET');
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.matches.length, 1);
    assert.equal(lookup.body.matches[0].buildingNumber, originalStoredVariant);

    const denied = await request('/buildings', 'POST', input(oldNumber, deeds[0].id));
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    const differentDeed = await request('/buildings', 'POST',
      input(' lEgAcy 70- ' + suffix, deeds[1].id));
    assert.equal(differentDeed.status, 201, JSON.stringify(differentDeed.body));
    buildings.push(differentDeed.body);
    assert.equal(differentDeed.body.buildingNumber, oldNumber);
    const unchanged = await prisma.mosqueBuilding.findUnique({ where: { id: first.body.id } });
    assert.equal(unchanged.buildingNumber, originalStoredVariant);
  });

  test('simultaneous writes with alternative whitespace cannot create two records under one deed', async () => {
    const number = 'R70-' + suffix;
    const responses = await Promise.all([
      request('/buildings', 'POST', input(' R 70 - ' + suffix, deeds[0].id)),
      request('/buildings', 'POST', input('r70-' + suffix, deeds[0].id)),
    ]);
    assert.deepEqual(responses.map((x) => x.status).sort(), [201, 409],
      JSON.stringify(responses));
    const successful = responses.find((item) => item.status === 201);
    buildings.push(successful.body);
    assert.equal(successful.body.buildingNumber, number);
    const stored = await prisma.mosqueBuilding.findMany({
      where: { deedId: deeds[0].id, buildingNumber: number },
    });
    assert.equal(stored.length, 1);
  });

  test('non-existing and other operating statuses can be saved and edited', async () => {
    const number = 'NONEXIST-' + suffix;
    const created = await request('/buildings', 'POST', {
      ...input(number, deeds[0].id, 'مبنى تجريبي غير قائم'),
      operationalStatus: 'not_existing',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.operationalStatus, 'not_existing');
    buildings.push(created.body);

    const updated = await request('/buildings/' + created.body.id, 'PUT', {
      ...input(number, deeds[0].id, 'مبنى تجريبي غير قائم'),
      operationalStatus: 'other',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.operationalStatus, 'other');

    const saved = await prisma.mosqueBuilding.findUnique({ where: { id: created.body.id } });
    assert.equal(saved.operationalStatus, 'other');
  });

  test('registration date/time is server-stamped, readonly for employees and editable by admins with an audit record', async () => {
    const admin = await prisma.appUser.create({
      data: {
        username: 'time-admin-' + suffix,
        email: 'time-admin-' + suffix + '@example.invalid',
        passwordHash: 'synthetic-test-only',
        isActive: true,
        role: 'admin',
      },
    });
    try {
      const number = 'TIMECI-' + suffix;
      const forgedCreate = await request('/buildings', 'POST', {
        ...input(number, deeds[0].id),
        registrationAt: '2020-01-01T00:00:00.000Z',
      });
      assert.equal(forgedCreate.status, 403, 'Client must not forge the initial registration timestamp');

      const start = Date.now();
      const created = await request('/buildings', 'POST', input(number, deeds[0].id));
      const finish = Date.now();
      assert.equal(created.status, 201, JSON.stringify(created.body));
      buildings.push(created.body);
      assert.ok(created.body.registrationAt, 'Backend must stamp new records');
      const stamped = new Date(created.body.registrationAt).getTime();
      assert.ok(stamped >= start - 1000 && stamped <= finish + 1000,
        'Server timestamp must match actual creation time');

      const immutableCreatedAt = created.body.createdAt;
      const impersonation = await request('/buildings/' + created.body.id, 'PUT', {
        ...input(number, deeds[0].id),
        registrationAt: '2020-01-01T00:00:00.000Z',
      });
      assert.equal(impersonation.status, 403, 'Owner with edit permissions cannot change registration time');

      const normalUpdate = await request('/buildings/' + created.body.id, 'PUT', {
        ...input(number, deeds[0].id, 'تعديل عادي لا يغير التاريخ'),
      });
      assert.equal(normalUpdate.status, 200, JSON.stringify(normalUpdate.body));
      assert.equal(new Date(normalUpdate.body.registrationAt).getTime(), stamped);

      const adminPut = await fetch(baseUrl + '/api/mosques/buildings/' + created.body.id, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer ' + signAccessToken(admin),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...input(number, deeds[0].id),
          registrationAt: '2026-04-15T09:35:00.000Z',
        }),
      });
      assert.equal(adminPut.status, 200, await adminPut.text().catch(() => ''));
      const after = await prisma.mosqueBuilding.findUnique({ where: { id: created.body.id } });
      assert.equal(after.registrationAt.toISOString(), '2026-04-15T09:35:00.000Z');
      assert.equal(after.createdAt.toISOString(), immutableCreatedAt,
        'Original audit creation timestamp must not change');
      const audit = await prisma.auditLog.findFirst({
        where: {
          module: 'central_buildings', entity: 'MosqueBuilding',
          entityId: created.body.id,
          description: 'تصحيح تاريخ ووقت تسجيل المبنى بواسطة المسؤول',
        },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(audit, 'Administrator corrections must leave an audit event');
      assert.equal(audit.userId, admin.id);

      const forgedOriginal = await fetch(baseUrl + '/api/mosques/buildings/' + created.body.id, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer ' + signAccessToken(admin),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...input(number, deeds[0].id),
          createdAt: '2022-01-01T00:00:00.000Z',
        }),
      });
      assert.equal(forgedOriginal.status, 403);
    } finally {
      await prisma.appUser.delete({ where: { id: admin.id } });
    }
  });

  test('the same pending import number cannot be inserted twice without a deed', async () => {
    const number = 'IMP-CI-' + suffix;
    const pending = await request('/buildings', 'POST', input(number, null));
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    buildings.push(pending.body);
    const duplicate = await request('/buildings', 'POST', input(number, null));
    assert.equal(duplicate.status, 409);
  });
} else {
  test('central building/deed composite tests require disposable local PostgreSQL',
    { skip: true }, () => {});
}
