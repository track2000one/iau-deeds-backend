import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBuildingNumber } from '../src/utils/normalizeBuildingNumber.js';

test('a building number is identical despite whitespace and letter case', () => {
  for (const candidate of ['A70', 'a70', 'A 70', 'a  70', ' A\t70 ', 'Ａ７０', 'a\u200B70', 'A\n70', 'A٧٠', 'a۷۰']) {
    assert.equal(normalizeBuildingNumber(candidate), 'A70', candidate);
  }
});

test('separate meaningful punctuation remains distinct', () => {
  assert.equal(normalizeBuildingNumber('A-70'), 'A-70');
  assert.notEqual(normalizeBuildingNumber('A-70'), normalizeBuildingNumber('A70'));
  assert.equal(normalizeBuildingNumber('   '), '');
});
