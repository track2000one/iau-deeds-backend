from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')

old = """const fieldTourAccessState = (req, tour) => {
  const isSystemAdmin = req.authUser?.role === 'admin';
  const isOwner = Boolean(tour?.createdBy && tour.createdBy === req.authUser?.id);
  const hasStarted = tour?.status !== 'scheduled' || (tour?.visits || []).some(fieldVisitHasExecutionData);
  return {
    isOwner,
    hasStarted,
    canEdit: Boolean(isSystemAdmin || isOwner),
    canDelete: Boolean(isSystemAdmin || isOwner),
    canCancel: Boolean((isSystemAdmin || isOwner) && tour?.status !== 'cancelled'),
  };
};

const fieldVisitAccessState = (req, visit) => {
  const isSystemAdmin = req.authUser?.role === 'admin';
  const isOwner = Boolean(visit?.createdBy && visit.createdBy === req.authUser?.id);
  const hasStarted = fieldVisitHasExecutionData(visit);
  return {
    isOwner,
    hasStarted,
    canEdit: Boolean(isSystemAdmin || isOwner),
    canDelete: Boolean(isSystemAdmin || (isOwner && !hasStarted)),
  };
};
"""
new = """const fieldTourAccessState = (req, tour) => {
  const isSystemAdmin = req.authUser?.role === 'admin';
  const isUnitHead = req.mosqueRole?.role === 'head';
  const isOwner = Boolean(tour?.createdBy && tour.createdBy === req.authUser?.id);
  const hasStarted = tour?.status !== 'scheduled' || (tour?.visits || []).some(fieldVisitHasExecutionData);
  const mosquePermission = req.authUser?.permissions?.find((item) => item.module === 'mosques');
  const canEditByPermission = isSystemAdmin || Boolean(mosquePermission?.canEdit);
  const canDeleteByPermission = isSystemAdmin || Boolean(mosquePermission?.canDelete);
  const canManageRecord = isSystemAdmin || isUnitHead || isOwner;
  return {
    isOwner,
    hasStarted,
    canEdit: Boolean(canEditByPermission && canManageRecord),
    canDelete: Boolean(canDeleteByPermission && canManageRecord),
    canCancel: Boolean(canEditByPermission && canManageRecord && tour?.status !== 'cancelled'),
  };
};

const fieldVisitAccessState = (req, visit) => {
  const isSystemAdmin = req.authUser?.role === 'admin';
  const isUnitHead = req.mosqueRole?.role === 'head';
  const isOwner = Boolean(visit?.createdBy && visit.createdBy === req.authUser?.id);
  const hasStarted = fieldVisitHasExecutionData(visit);
  const mosquePermission = req.authUser?.permissions?.find((item) => item.module === 'mosques');
  const canEditByPermission = isSystemAdmin || Boolean(mosquePermission?.canEdit);
  const canDeleteByPermission = isSystemAdmin || Boolean(mosquePermission?.canDelete);
  const canManageRecord = isSystemAdmin || isUnitHead || isOwner;
  return {
    isOwner,
    hasStarted,
    canEdit: Boolean(canEditByPermission && canManageRecord),
    canDelete: Boolean(canDeleteByPermission && canManageRecord),
  };
};
"""
if old not in text:
    raise SystemExit('field access-state block not found')
text = text.replace(old, new, 1)

# Unit head is a full manager for tours/visits. Other users remain owner-only.
old_guard = """    const isSystemAdmin = req.authUser?.role === 'admin';
    const isOwner = current.createdBy === req.authUser?.id;
    if (!isSystemAdmin && !isOwner) {
"""
new_guard = """    const isSystemAdmin = req.authUser?.role === 'admin';
    const isUnitHead = req.mosqueRole?.role === 'head';
    const isOwner = current.createdBy === req.authUser?.id;
    if (!isSystemAdmin && !isUnitHead && !isOwner) {
"""
count = text.count(old_guard)
if count < 4:
    raise SystemExit(f'expected at least 4 ownership guards, found {count}')
text = text.replace(old_guard, new_guard)

old_started = """    if (!isSystemAdmin && fieldVisitHasExecutionData(current)) {
      return res.status(409).json({ message: 'بدأ تنفيذ هذه الزيارة أو أصبحت جزءًا من السجل التاريخي؛ أغلق الزيارة أو ألغِ الجولة المرتبطة بدل حذف السجل.' });
    }

"""
if old_started not in text:
    raise SystemExit('visit started-delete restriction not found')
text = text.replace(old_started, '', 1)

path.write_text(text, encoding='utf-8')
print('Applied owner/head tour and visit permissions')
