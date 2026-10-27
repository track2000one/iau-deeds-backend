import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/prisma.js';
import { signAccessToken } from '../src/security/auth.js';

const unique = randomUUID().slice(0, 12);
let server;
let baseUrl;
let deed;
let owner;
let other;
let admin;
let noPermission;
const created = [];

const createUser = (name, role, grant = true) => prisma.appUser.create({
  data: {
    username: name,
    email: name + '-' + unique + '@example.invalid',
    passwordHash: 'test-only-not-a-login',
    role,
    isActive: true,
    ...(role === 'employee' && grant ? {
      permissions: { create: { module: 'vacant_lands', canView: true, canAdd: true, canEdit: true, canDelete: true, canPrint: true } },
    } : {}),
  },
});

const request = async (path, method = 'GET', user = owner, body) => {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(user ? { authorization: 'Bearer ' + signAccessToken(user) } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data };
};

const payload = (code, overrides = {}) => ({
  code,
  name: 'الموقع التجريبي',
  campus: 'الحرم الجامعي الشرقي',
  deedId: deed.id,
  approximateArea: 1000,
  status: 'DRAFT',
  ...overrides,
});

if (process.env.VACANT_LANDS_INTEGRATION === '1') {
before(async () => {
  process.env.JWT_SECRET ||= 'vacant-lands-integration-test-secret-2026-really-long';
  deed = await prisma.deed.create({
    data: { propertyDescription: 'صك اختبار الأراضي الشاغرة', usageType: 'other', deedNumber: 'VL-TEST-' + unique, area: 5000 },
  });
  owner = await createUser('vl-owner', 'employee');
  other = await createUser('vl-other', 'employee');
  admin = await createUser('vl-admin', 'admin');
  noPermission = await createUser('vl-restricted', 'employee', false);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (created.length) await prisma.vacantLand.deleteMany({ where: { id: { in: created } } });
  await prisma.userPermission.deleteMany({ where: { userId: { in: [owner?.id, other?.id, admin?.id, noPermission?.id].filter(Boolean) } } });
  await prisma.appUser.deleteMany({ where: { id: { in: [owner?.id, other?.id, admin?.id, noPermission?.id].filter(Boolean) } } });
  if (deed) await prisma.deed.delete({ where: { id: deed.id } });
  await prisma.$disconnect();
});

test('authentication and dedicated permission deny unauthorized requests', async () => {
  assert.equal((await request('/api/vacant-lands', 'GET', null)).status, 401);
  assert.equal((await request('/api/vacant-lands', 'GET', noPermission)).status, 403);
  assert.equal((await request('/api/vacant-lands/deed-options', 'GET', noPermission)).status, 403);
  const d = await request('/api/vacant-lands/deed-options?q=' + encodeURIComponent(deed.deedNumber));
  assert.equal(d.status, 200);
  assert.ok(d.data.some((value) => value.id === deed.id));
});

test('employee creates draft linked to existing deed; status is not verified', async () => {
  const response = await request('/api/vacant-lands', 'POST', owner, payload('VL-' + unique));
  assert.equal(response.status, 201, JSON.stringify(response.data));
  created.push(response.data.id);
  assert.equal(response.data.deed.deedNumber, deed.deedNumber);
  assert.equal(response.data.createdByName, owner.username);
  assert.equal(response.data.status, 'DRAFT');
  assert.equal(response.data.verifiedVacantArea, null);
});

test('invalid area, missing deed, and unauthorized verified area are rejected', async () => {
  const code = 'BAD-' + unique;
  const tooLarge = await request('/api/vacant-lands', 'POST', owner,
    payload(code, { verifiedVacantArea: 1001 }));
  assert.equal(tooLarge.status, 400);
  assert.equal((await request('/api/vacant-lands', 'POST', owner,
    payload(code, { deedId: 'non-existent' }))).status, 400);
  assert.equal((await request('/api/vacant-lands', 'POST', owner,
    payload(code, { verifiedVacantArea: 100 }))).status, 403);
  assert.equal((await request('/api/vacant-lands', 'POST', owner,
    payload(code, { status: 'VERIFIED_VACANT', verifiedVacantArea: 100 }))).status, 403);
});

test('creator-only edits, admin verification requires inspection date', async () => {
  const id = created[0];
  assert.equal((await request('/api/vacant-lands/' + id, 'PUT', other,
    payload('VL-' + unique, { name: 'غير مصرح' }))).status, 403);
  assert.equal((await request('/api/vacant-lands/' + id, 'DELETE', other)).status, 403);
  assert.equal((await request('/api/vacant-lands/' + id, 'PUT', admin,
    payload('VL-' + unique, { status: 'VERIFIED_VACANT', verifiedVacantArea: 750 }))).status, 400);
  const approved = await request('/api/vacant-lands/' + id, 'PUT', admin,
    payload('VL-' + unique, {
      status: 'VERIFIED_VACANT',
      verifiedVacantArea: 750,
      inspectionDate: '2026-10-27T12:00:00.000Z',
    }));
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.verifiedByName, admin.username);
  assert.ok(approved.data.verifiedAt);
  assert.equal(Number(approved.data.verifiedVacantArea), 750);
  assert.equal((await request('/api/vacant-lands/' + id, 'DELETE', owner)).status, 403);
  assert.equal((await request('/api/vacant-lands/' + id, 'DELETE', admin)).status, 204);
  created.length = 0;
});


test('GeoJSON boundaries remain linked to the deed and approval is cleared when boundaries change', async () => {
  const first = {
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[
      [50.18, 26.39], [50.181, 26.39], [50.181, 26.391], [50.18, 26.391], [50.18, 26.39],
    ]] },
  };
  const second = {
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[
      [50.18, 26.39], [50.182, 26.39], [50.182, 26.391], [50.18, 26.391], [50.18, 26.39],
    ]] },
  };
  const code = 'GIS-' + unique;
  const initial = await request('/api/vacant-lands', 'POST', owner,
    payload(code, { approximateArea: 20000, geometryGeoJson: first, geometrySourceName: 'doc.kml' }));
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  created.push(initial.data.id);
  const id = initial.data.id;
  assert.equal(initial.data.deedId, deed.id);
  assert.equal(initial.data.geometrySourceName, 'doc.kml');
  assert.equal(initial.data.geometryGeoJson.geometry.type, 'Polygon');
  assert.ok(Number(initial.data.latitude) > 26.39);

  const approved = await request('/api/vacant-lands/' + id, 'PUT', admin,
    payload(code, {
      approximateArea: 20000, geometryGeoJson: initial.data.geometryGeoJson,
      geometrySourceName: 'doc.kml', status: 'VERIFIED_VACANT',
      inspectionDate: '2026-10-27T12:00:00.000Z',
      verifiedVacantArea: 7500,
    }));
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.verifiedByName, admin.username);

  const unsafe = await request('/api/vacant-lands/' + id, 'PUT', admin,
    payload(code, {
      approximateArea: 20000, geometryGeoJson: second,
      status: 'VERIFIED_VACANT', inspectionDate: '2026-10-27T12:00:00.000Z', verifiedVacantArea: 7500,
    }));
  assert.equal(unsafe.status, 409);

  const revision = await request('/api/vacant-lands/' + id, 'PUT', admin,
    payload(code, {
      approximateArea: 20000, geometryGeoJson: second, geometrySourceName: 'revision.kmz',
      status: 'UNDER_REVIEW', verifiedVacantArea: null,
    }));
  assert.equal(revision.status, 200, JSON.stringify(revision.data));
  assert.equal(revision.data.status, 'UNDER_REVIEW');
  assert.equal(revision.data.verifiedAt, null);
  assert.equal(revision.data.verifiedVacantArea, null);
  assert.equal(revision.data.geometryUpdatedByName, admin.username);
  assert.equal(revision.data.geometrySourceName, 'revision.kmz');

  const invalidPolygon = await request('/api/vacant-lands/' + id, 'PUT', admin,
    payload(code, {
      approximateArea: 20000, status: 'UNDER_REVIEW',
      geometryGeoJson: {
        type: 'Polygon',
        coordinates: [[[50.18, 26.39], [50.181, 26.391], [50.18, 26.391], [50.181, 26.39], [50.18, 26.39]]],
      },
    }));
  assert.equal(invalidPolygon.status, 400);
});


test('bulk import previews exact deed-number identity and commits only clean batches as drafts', async () => {
  const prefix = 'BULK-' + unique;
  const valid = {
    code: prefix + '-01', name: 'موقع أولي', campus: 'الحرم الجامعي الشرقي',
    deedNumber: deed.deedNumber, approximateArea: 1200,
    latitude: 26.391, longitude: 50.19,
    sourceReference: 'بيان حصر أولي - صفحة 3',
  };
  const bad = { ...valid, code: prefix + '-02', deedNumber: 'غير-موجود-' + unique };
  const preview = await request('/api/vacant-lands/import/preview', 'POST', owner, { rows: [valid, bad] });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.ready, 1);
  assert.equal(preview.data.blocked, 1);
  assert.equal(preview.data.rows[0].linkedDeed.id, deed.id);
  const denied = await request('/api/vacant-lands/import/commit', 'POST', owner, { rows: [valid] });
  assert.equal(denied.status, 403);
  const rejected = await request('/api/vacant-lands/import/commit', 'POST', admin, { rows: [valid, bad] });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  const notWritten = await prisma.vacantLand.count({ where: { code: valid.code } });
  assert.equal(notWritten, 0, 'atomic commit must not write an incomplete batch');
  const imported = await request('/api/vacant-lands/import/commit', 'POST', admin, { rows: [valid] });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  assert.equal(imported.data.count, 1);
  created.push(imported.data.records[0].id);
  const stored = await prisma.vacantLand.findUnique({ where: { code: valid.code.toUpperCase() } });
  assert.equal(stored.deedId, deed.id);
  assert.equal(stored.status, 'DRAFT');
  assert.equal(stored.verifiedVacantArea, null);
  assert.equal(stored.createdByName, admin.username);
  const repeat = await request('/api/vacant-lands/import/preview', 'POST', admin, { rows: [valid] });
  assert.equal(repeat.data.blocked, 1);
  const duplicates = await request('/api/vacant-lands/import/preview', 'POST', owner, { rows: [valid, valid] });
  assert.equal(duplicates.data.blocked, 2);
});

test('deed link resolves central buildings and additional investment-site deeds read-only', async () => {
  let building;
  let site;
  let area;
  let opportunity;
  try {
    building = await prisma.mosqueBuilding.create({ data: {
      buildingNumber: 'VL-BUILD-' + unique,
      name: 'مبنى مرتبط بالصك',
      deedId: deed.id,
    } });
    site = await prisma.investmentSite.create({
      data: {
        code: 'VL-INV-' + unique, name: 'موقع استثماري متعدد الصكوك',
        deedLinks: { create: { deedId: deed.id, isPrimary: true } },
      },
    });
    area = await prisma.investmentArea.create({ data: {
      siteId: site.id, areaNumber: 1, areaCode: 'VL-AREA-' + unique,
    } });
    opportunity = await prisma.investmentOpportunity.create({ data: {
      areaId: area.id, opportunityNumber: 'VL-OP-' + unique, title: 'فرصة مسجلة لدى الإدارة المختصة',
    } });
    const adminResult = await request('/api/vacant-lands/deed-relations/' + deed.id, 'GET', admin);
    assert.equal(adminResult.status, 200, JSON.stringify(adminResult.data));
    assert.equal(adminResult.data.deed.deedNumber, deed.deedNumber);
    assert.ok(adminResult.data.buildings.some((x) => x.id === building.id));
    const match = adminResult.data.investmentSites.find((x) => x.id === site.id);
    assert.ok(match, 'additional deed links must resolve as well as primary deed links');
    assert.ok(match.areas[0].opportunities.some((x) => x.id === opportunity.id));
    const limited = await request('/api/vacant-lands/deed-relations/' + deed.id, 'GET', owner);
    assert.equal(limited.status, 200);
    assert.equal(limited.data.permissions.buildingsVisible, false);
    assert.equal(limited.data.permissions.investmentsVisible, false);
    assert.deepEqual(limited.data.buildings, []);
    assert.deepEqual(limited.data.investmentSites, []);
  } finally {
    if (opportunity) await prisma.investmentOpportunity.delete({ where: { id: opportunity.id } });
    if (area) await prisma.investmentArea.delete({ where: { id: area.id } });
    if (site) await prisma.investmentSite.delete({ where: { id: site.id } });
    if (building) await prisma.mosqueBuilding.delete({ where: { id: building.id } });
  }
});

} else {
  test('vacant-lands integration tests require a disposable PostgreSQL instance', { skip: true }, () => {});
}
