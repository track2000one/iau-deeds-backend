// Shared record-ownership guard. Legacy records without an owner stay admin-managed.
export const canManageOwnedRecord = (user, record) => Boolean(
  user &&
  (
    user.role === 'admin' ||
    (record?.createdBy && record.createdBy === user.id)
  )
);

// Enforce ownership in the database WHERE clause as well as in route checks.
export const ownedRecordWhere = (user, id) => (
  user?.role === 'admin'
    ? { id }
    : { id, createdBy: user?.id || '__no_authenticated_owner__' }
);
