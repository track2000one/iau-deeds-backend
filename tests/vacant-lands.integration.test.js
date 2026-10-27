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
