import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/prisma.js';
import { previewVacantImport, commitVacantImport } from '../src/services/vacant-lands-linkage.service.js';

if (process.env.NODE_ENV !== 'test' || process.env.VACANT_LANDS_INTEGRATION !== '1') {
  throw Error('This script may run only against an explicit, disposable integration database.');
}

const code = 'VLPRE-' + randomUUID().slice(0, 12);
let deed;
try {
  const exists = await prisma.$queryRawUnsafe('SELECT to_regclass(\'public."VacantLand"\')::text AS "tableName"');
  assert.equal(exists[0].tableName, null, 'VacantLand must be absent for this test');
  deed = await prisma.deed.create({
    data: {
      deedNumber: code + '-DEED',
      usageType: 'other',
      propertyDescription: 'Temporary test deed for read-only preflight',
      area: 10000,
    },
  });
  const valid = {
    code,
    name: 'موقع تحت الدراسة',
    campus: 'الحرم الجامعي الشرقي',
    deedNumber: deed.deedNumber,
    approximateArea: 1200,
  };
  const report = await previewVacantImport({ rows: [valid] });
  assert.equal(report.schemaReady, false);
  assert.equal(report.deedMatched, 1);
  assert.equal(report.ready, 0);
  assert.equal(report.blocked, 1);
  assert.equal(report.rows[0].deedId, deed.id);
  assert.ok(report.rows[0].issues.some((item) => item.includes('بانتظار التهيئة')));

  const duplicate = await previewVacantImport({ rows: [valid, valid] });
  assert.equal(duplicate.blocked, 2);
  assert.ok(duplicate.rows.every((r) => r.issues.some((i) => i.includes('مكرر'))));

  const unknown = await previewVacantImport({ rows: [{ ...valid, deedNumber: 'UNKNOWN-' + code }] });
  assert.equal(unknown.deedMatched, 0);
  assert.equal(unknown.blocked, 1);

  const attempt = await commitVacantImport(
    { rows: [valid] },
    { id: 'integration-admin', username: 'integration-test-admin' },
  );
  assert.equal(attempt.committed, false);
  assert.equal(attempt.blocked, 1);
  assert.equal(attempt.count, undefined);
  console.log('PASS: deed preflight works before VacantLand schema, writes are blocked.');
} finally {
  if (deed) await prisma.deed.delete({ where: { id: deed.id } });
  await prisma.$disconnect();
}
