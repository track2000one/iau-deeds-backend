import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccountingStableKey,
  getAccountingLandDeedIdentity,
  getAccountingRecordMatchKey,
  synchronizeAccountingLandStableKeys,
} from '../src/services/accountingCycles.service.js';

const base = { B: 'جامعة الإمام عبدالرحمن بن فيصل', C: '0029', D: '', E: 'legacy-asset', G: 'أرض جامعية' };

test('land stable key is deed number AJ plus deed date AG', () => {
  const payload = { ...base, AJ: '360607002075', AG: '10/3/1398' };
  assert.equal(createAccountingStableKey('land', payload), 'land:deed:360607002075:10-3-1398');
});

test('same deed is stable even when legacy asset number changes', () => {
  const first = { ...base, E: 'A-1', AJ: '330115016381', AG: '29/8/1442' };
  const second = { ...base, E: 'A-99', AJ: '330115016381', AG: '29/08/1442' };
  assert.equal(createAccountingStableKey('land', first), createAccountingStableKey('land', second));
});

test('different deed number or deed date produces a different land identity', () => {
  const first = { ...base, AJ: '330103025654', AG: '23/6/1440' };
  const second = { ...base, AJ: '730103028454', AG: '18/5/1441' };
  assert.notEqual(createAccountingStableKey('land', first), createAccountingStableKey('land', second));
});

test('arabic digits and zero-padded deed dates normalize consistently', () => {
  const latin = getAccountingLandDeedIdentity({ AJ: '517902005797', AG: '08/03/1398' });
  const arabic = getAccountingLandDeedIdentity({ AJ: '٥١٧٩٠٢٠٠٥٧٩٧', AG: '٨/٣/١٣٩٨' });
  assert.equal(latin.deedNumber, arabic.deedNumber);
  assert.equal(latin.deedDate, arabic.deedDate);
  assert.equal(latin.deedDate, '8-3-1398');
});

test('missing AJ/AG falls back to the legacy identity path', () => {
  const key = createAccountingStableKey('land', { ...base, AJ: 'Not Available', AG: 'Not Available' });
  assert.match(key, /^land:entity:/);
});

test('record matching recomputes AJ+AG even when stored stable key is legacy', () => {
  const record = { recordType: 'land', stableKey: 'land:entity:0029:legacy-asset', payload: { ...base, AJ: '930105021011', AG: '22/9/1439' } };
  assert.equal(getAccountingRecordMatchKey(record), 'land:deed:930105021011:22-9-1439');
});

test('stable-key synchronization updates only deed-bearing land rows', async () => {
  const updates = [];
  const client = { accountingTransformationRecord: {
    findMany: async () => [
      { id: 'a', stableKey: 'land:entity:0029:1', payload: { ...base, AJ: '730105021013', AG: '22/9/1439' } },
      { id: 'b', stableKey: 'land:entity:0029:2', payload: { ...base, AJ: 'Not Available', AG: 'Not Available' } },
    ],
    update: async (input) => { updates.push(input); return input; },
  } };
  const count = await synchronizeAccountingLandStableKeys(client);
  assert.equal(count, 1);
  assert.equal(updates[0].where.id, 'a');
  assert.equal(updates[0].data.stableKey, 'land:deed:730105021013:22-9-1439');
});
