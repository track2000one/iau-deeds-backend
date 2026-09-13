import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNTING_STAGE6_SOURCE,
  stage6MatricesToItems,
  validateStage6Items,
} from '../src/services/accountingStage6Baseline.service.js';

const makeRow = ({ deed = false, label = 'سجل' } = {}) => {
  const row = Array(69).fill('');
  row[1] = 'جامعة الامام عبدالرحمن بن فيصل'; // B
  row[6] = label; // G
  if (deed) {
    row[32] = '10/3/1398'; // AG
    row[35] = `36060700${Math.floor(Math.random() * 9999)}`; // AJ
  } else {
    row[32] = 'Not Available';
    row[35] = 'Not Available';
  }
  return row;
};

test('Stage 6 constants match the reviewed workbook baseline', () => {
  assert.equal(ACCOUNTING_STAGE6_SOURCE.expected.land, 16);
  assert.equal(ACCOUNTING_STAGE6_SOURCE.expected.building, 625);
  assert.equal(ACCOUNTING_STAGE6_SOURCE.expected.total, 641);
  assert.equal(ACCOUNTING_STAGE6_SOURCE.expected.deedBearingLand, 11);
  assert.equal(ACCOUNTING_STAGE6_SOURCE.originalFileSha256.length, 64);
});

test('Stage 6 matrices preserve AJ + AG as the land deed identity fields', () => {
  const landValues = Array.from({ length: 16 }, (_, index) => makeRow({ deed: index < 11, label: `أرض ${index + 1}` }));
  const buildingValues = Array.from({ length: 625 }, (_, index) => {
    const row = Array(91).fill('');
    row[1] = 'جامعة الامام عبدالرحمن بن فيصل';
    row[6] = `مبنى ${index + 1}`;
    return row;
  });

  const items = stage6MatricesToItems({ landValues, buildingValues });
  const counts = validateStage6Items(items);

  assert.deepEqual(counts, ACCOUNTING_STAGE6_SOURCE.expected);
  assert.equal(items[0].payload.AG, '10/3/1398');
  assert.ok(items[0].payload.AJ);
  assert.equal(items[0].sourceRow, 8);
  assert.equal(items[15].sourceRow, 23);
  assert.equal(items[16].recordType, 'building');
  assert.equal(items.at(-1).sourceRow, 632);
});

test('Stage 6 validation blocks incomplete or silently truncated imports', () => {
  const landValues = Array.from({ length: 15 }, (_, index) => makeRow({ deed: index < 11 }));
  const buildingValues = Array.from({ length: 625 }, (_, index) => {
    const row = Array(91).fill('');
    row[1] = 'جامعة الامام عبدالرحمن بن فيصل';
    row[6] = `مبنى ${index + 1}`;
    return row;
  });
  const items = stage6MatricesToItems({ landValues, buildingValues });
  assert.throws(() => validateStage6Items(items), /validation failed/i);
});
