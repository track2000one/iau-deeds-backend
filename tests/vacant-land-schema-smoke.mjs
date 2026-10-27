import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

if (process.env.NODE_ENV !== 'test') {
  throw new Error('This schema smoke test can only run with NODE_ENV=test');
}

const db = new PrismaClient();
const unique = randomUUID().slice(0, 10);
let deed;
let land;
try {
  const hasTable = await db.$queryRawUnsafe(
    'SELECT to_regclass(\'public."VacantLand"\')::text AS "tableName"'
  );
  assert.equal(hasTable[0].tableName, '"VacantLand"');

  deed = await db.deed.create({
    data: {
      deedNumber: 'VL-MIGRATION-TEST-' + unique,
      propertyDescription: 'Temporary deed for schema smoke test',
      usageType: 'other',
      area: 5500,
    },
  });
  land = await db.vacantLand.create({
    data: {
      code: 'VL-MIGRATION-TEST-' + unique,
      name: 'Temporary test vacant land',
      campus: 'Temporary test campus',
      deedId: deed.id,
      approximateArea: 1234.56,
    },
    include: { deed: { select: { deedNumber: true } } },
  });

  assert.equal(land.deed.deedNumber, deed.deedNumber);
  assert.equal(land.status, 'DRAFT');
  assert.equal(Number(land.approximateArea), 1234.56);
  assert.equal(land.verifiedVacantArea, null);

  await assert.rejects(
    () => db.deed.delete({ where: { id: deed.id } }),
    (error) => error.code === 'P2003',
    'The deed foreign key must protect linked vacant-land records'
  );
  console.log('PASS: VacantLand exists; default, area, and FK integrity all verified in disposable database.');
} finally {
  if (land?.id) await db.vacantLand.delete({ where: { id: land.id } });
  if (deed?.id) await db.deed.delete({ where: { id: deed.id } });
  await db.$disconnect();
}
