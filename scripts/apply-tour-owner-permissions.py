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
    canDelete: Boolean(isSystemAdmin || (isOwner && !hasStarted)),
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
    canDelete: Boolean(isSystemAdmin || (isOwner && !hasStarted)),
  };
};
"""
new = """const fieldTourAccessState = (req, tour) => {
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
if old not in text:
    raise SystemExit('access-state block not found')
text = text.replace(old, new, 1)

old = """    res.status(201).json(created);
  } catch (error) { next(error); }
});

router.patch('/field-tours/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
"""
new = """    res.status(201).json({ ...created, ...fieldTourAccessState(req, created) });
  } catch (error) { next(error); }
});

router.patch('/field-tours/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
"""
if old not in text:
    raise SystemExit('tour create response block not found')
text = text.replace(old, new, 1)

old = """    const input = z.object({
      status: z.enum(['scheduled', 'in_progress', 'completed', 'postponed', 'cancelled']),
      notes: z.string().trim().max(5000).optional().nullable(),
    }).parse(req.body);
    const isSystemAdmin = req.authUser?.role === 'admin';
    const isOwner = current.createdBy === req.authUser?.id;
    if (input.status === 'cancelled' && current.status !== 'cancelled' && !isSystemAdmin && !isOwner) {
      return res.status(403).json({ message: 'لا يمكن إلغاء الجولة إلا بواسطة منشئها أو مسؤول المنصة' });
    }
"""
new = """    const input = z.object({
      status: z.enum(['scheduled', 'in_progress', 'completed', 'postponed', 'cancelled']),
      notes: z.string().trim().max(5000).optional().nullable(),
    }).parse(req.body);
    const isSystemAdmin = req.authUser?.role === 'admin';
    const isOwner = current.createdBy === req.authUser?.id;
    if (!isSystemAdmin && !isOwner) {
      return res.status(403).json({ message: 'هذه الجولة أنشأها مستخدم آخر؛ يمكنك عرضها فقط ولا تملك صلاحية تعديلها أو إلغائها.' });
    }
"""
if old not in text:
    raise SystemExit('tour patch ownership block not found')
text = text.replace(old, new, 1)

old = """    const hasStarted = current.status !== 'scheduled' || current.visits.some(fieldVisitHasExecutionData);
    if (!isSystemAdmin && hasStarted) {
      return res.status(409).json({ message: 'بدأ تنفيذ هذه الجولة أو أصبحت جزءًا من السجل التاريخي؛ استخدم «إلغاء الجولة» بدل الحذف.' });
    }

    const visitIds = current.visits.map((visit) => visit.id);
"""
new = """    const visitIds = current.visits.map((visit) => visit.id);
"""
if old not in text:
    raise SystemExit('tour started-delete restriction block not found')
text = text.replace(old, new, 1)

old = """    if (context.role === 'supervisor') {
      await assertSupervisorSiteAccess(req, current.siteId, context);
      if (req.body.siteId && req.body.siteId !== current.siteId) await assertSupervisorSiteAccess(req, req.body.siteId, context);
    }
    const input = fieldVisitSchema.parse(req.body);
"""
new = """    if (context.role === 'supervisor') {
      await assertSupervisorSiteAccess(req, current.siteId, context);
      if (req.body.siteId && req.body.siteId !== current.siteId) await assertSupervisorSiteAccess(req, req.body.siteId, context);
    }
    const isSystemAdmin = req.authUser?.role === 'admin';
    const isOwner = current.createdBy === req.authUser?.id;
    if (!isSystemAdmin && !isOwner) {
      return res.status(403).json({ message: 'هذه الزيارة تتبع جولة أنشأها مستخدم آخر؛ يمكنك عرضها فقط ولا تملك صلاحية تعديلها.' });
    }
    const input = fieldVisitSchema.parse(req.body);
"""
if old not in text:
    raise SystemExit('visit update access insertion point not found')
text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
print('Applied owner/admin field tour and visit edit permissions')
