import test from 'node:test';
import assert from 'node:assert/strict';
import { canManageOwnedRecord, ownedRecordWhere } from '../src/security/record-ownership.js';

const owner = { id: 'u1', role: 'employee' };
const colleague = { id: 'u2', role: 'employee' };
const admin = { id: 'root', role: 'admin' };

test('creator can manage only their own record', () => {
  assert.equal(canManageOwnedRecord(owner, { id: 'b1', createdBy: 'u1' }), true);
  assert.equal(canManageOwnedRecord(colleague, { id: 'b1', createdBy: 'u1' }), false);
});

test('admin can manage all records including legacy records', () => {
  assert.equal(canManageOwnedRecord(admin, { id: 'b1', createdBy: 'u1' }), true);
  assert.equal(canManageOwnedRecord(admin, { id: 'legacy', createdBy: null }), true);
});

test('legacy unowned records are protected from non-admin modifications', () => {
  assert.equal(canManageOwnedRecord(owner, { id: 'legacy', createdBy: null }), false);
  assert.equal(canManageOwnedRecord(null, { id: 'b1', createdBy: 'u1' }), false);
});

test('database write predicates are scoped to the authenticated creator', () => {
  assert.deepEqual(ownedRecordWhere(owner, 'b1'), { id: 'b1', createdBy: 'u1' });
  assert.deepEqual(ownedRecordWhere(admin, 'b1'), { id: 'b1' });
  assert.deepEqual(ownedRecordWhere(null, 'b1'), { id: 'b1', createdBy: '__no_authenticated_owner__' });
});
