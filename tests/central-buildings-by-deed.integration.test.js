import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/prisma.js';
import { signAccessToken } from '../src/security/auth.js';

// This is deliberately opt-in and must only run against the disposable GitHub
// Actions PostgreSQL service. It never connects to Railway production.
const enabled = process.env.CENTRAL_BUILDINGS_INTEGRATION_TEST === '1';
const suffix = randomUUID().slice(0, 12);
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
