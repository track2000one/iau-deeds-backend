import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeedNumber } from '../src/services/vacant-lands-linkage.service.js';

test('Arabic-Indic and Eastern Arabic digits match Western deed numbers without dropping leading zeros', () => {
  assert.equal(normalizeDeedNumber(' ٠٠٣٣٠١-٠٩ '), '003301-09');
  assert.equal(normalizeDeedNumber('۰۰۳۳۰۱-۰۹'), '003301-09');
  assert.equal(normalizeDeedNumber('003301-09'), '003301-09');
});
test('Unicode bidirectional marks and surrounding whitespace are removed for matching', () => {
  assert.equal(normalizeDeedNumber('\u200f ١٢٣\u200e ٤٥٦ '), '123456');
});
test('deed normalization does not drop significant punctuation or fabricate a number', () => {
  assert.notEqual(normalizeDeedNumber('33-010'), normalizeDeedNumber('33010'));
  assert.equal(normalizeDeedNumber(''), '');
});
