import fs from 'node:fs';

const path = 'src/routes/mosques.routes.js';
let source = fs.readFileSync(path, 'utf8');

const replaceOnce = (from, to, label) => {
  const index = source.indexOf(from);
  if (index < 0) throw new Error(`Patch target not found: ${label}`);
  if (source.indexOf(from, index + from.length) >= 0 && label.startsWith('unique:')) {
    throw new Error(`Patch target is not unique: ${label}`);
  }
  source = source.slice(0, index) + to + source.slice(index + from.length);
};

replaceOnce(
`const activeFieldVisitMessage = (record) => \`يوجد إجراء ميداني قائم للموقع \${record.site.name} برقم \${record.visitNumber} وحالته الحالية \${record.workflowStatus === 'planned' ? 'مجدولة' : record.workflowStatus === 'in_progress' ? 'جارية' : 'تحتاج متابعة'}. افتح الزيارة القائمة بدل إنشاء زيارة مكررة.\`;
`,
`const activeFieldVisitMessage = (record) => \`يوجد إجراء ميداني قائم للموقع \${record.site.name} برقم \${record.visitNumber} وحالته الحالية \${record.workflowStatus === 'planned' ? 'مجدولة' : record.workflowStatus === 'in_progress' ? 'جارية' : 'تحتاج متابعة'}. افتح الزيارة القائمة بدل إنشاء زيارة مكررة.\`;

const hasNonEmptyJsonList = (value) => Array.isArray(value) && value.length > 0;
const fieldVisitHasExecutionData = (visit) => Boolean(
  visit && (
    visit.workflowStatus !== 'planned'
    || visit.departureAt
    || nullableText(visit.representativeName)
    || nullableText(visit.generalNotes)
    || nullableText(visit.recommendations)
    || hasNonEmptyJsonList(visit.attachments)
    || (visit.items || []).some((item) => (
      item.status !== 'not_checked'
      || nullableText(item.note)
      || nullableText(item.responsibleEntity)
      || item.dueDate
      || item.resolutionStatus !== 'new'
      || nullableText(item.resolutionNote)
      || hasNonEmptyJsonList(item.beforeImages)
      || hasNonEmptyJsonList(item.afterImages)
    ))
  )
);

const fieldTourAccessState = (req, tour) => {
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
`,
'unique: field visit ownership helpers',
);

replaceOnce(
`    res.json(tours);
  } catch (error) { next(error); }
});

router.post('/field-tours',`,
`    res.json(tours.map((tour) => ({ ...tour, ...fieldTourAccessState(req, tour) })));
  } catch (error) { next(error); }
});

router.post('/field-tours',`,
'unique: decorate field tours',
);

replaceOnce(
`    const current = await prisma.mosqueFieldTour.findUnique({ where: { id: req.params.id }, include: { visits: { select: { siteId: true } } } });
    if (!current) return res.status(404).json({ message: 'الجولة الميدانية غير موجودة' });
`,
`    const current = await prisma.mosqueFieldTour.findUnique({ where: { id: req.params.id }, include: { visits: { select: { siteId: true } } } });
    if (!current) return res.status(404).json({ message: 'الجولة الميدانية غير موجودة' });
`,
'unique: keep field tour current query',
);

replaceOnce(
`    const input = z.object({
      status: z.enum(['scheduled', 'in_progress', 'completed', 'postponed', 'cancelled']),
      notes: z.string().trim().max(5000).optional().nullable(),
    }).parse(req.body);
    const updated = await prisma.mosqueFieldTour.update({ where: { id: current.id }, data: { status: input.status, notes: input.notes === undefined ? current.notes : input.notes } });
    res.json(updated);
  } catch (error) { next(error); }
});

router.get('/field-visits/summary',`,
`    const input = z.object({
      status: z.enum(['scheduled', 'in_progress', 'completed', 'postponed', 'cancelled']),
      notes: z.string().trim().max(5000).optional().nullable(),
    }).parse(req.body);
    const isSystemAdmin = req.authUser?.role === 'admin';
    const isOwner = current.createdBy === req.authUser?.id;
    if (input.status === 'cancelled' && current.status !== 'cancelled' && !isSystemAdmin && !isOwner) {
      return res.status(403).json({ message: 'لا يمكن إلغاء الجولة إلا بواسطة منشئها أو مسؤول المنصة' });
    }
    const updated = await prisma.mosqueFieldTour.update({ where: { id: current.id }, data: { status: input.status, notes: input.notes === undefined ? current.notes : input.notes } });
    if (input.status === 'cancelled' && current.status !== 'cancelled') {
      try {
        await prisma.auditLog.create({ data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: 'CANCEL_MOSQUE_FIELD_TOUR',
          module: 'mosques',
          entity: 'MosqueFieldTour',
          entityId: current.id,
          entityLabel: current.tourNumber,
          description: \`إلغاء الجولة الميدانية \${current.tourNumber}: \${current.title}\`,
          previousData: { status: current.status },
          newData: { status: 'cancelled' },
        } });
      } catch (auditError) {
        console.warn('Unable to audit field tour cancellation:', auditError?.message || auditError);
      }
    }
    res.json({ ...updated, ...fieldTourAccessState(req, { ...current, ...updated }) });
  } catch (error) { next(error); }
});

router.delete('/field-tours/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const current = await prisma.mosqueFieldTour.findUnique({
      where: { id: req.params.id },
      include: {
        visits: {
          include: {
            items: {
              select: {
                id: true,
                status: true,
                note: true,
                responsibleEntity: true,
                dueDate: true,
                resolutionStatus: true,
                resolutionNote: true,
                beforeImages: true,
                afterImages: true,
              },
            },
          },
        },
      },
    });
    if (!current) return res.status(404).json({ message: 'الجولة الميدانية غير موجودة' });

    if (context.role === 'supervisor') {
      const managed = new Set(await getManagedSiteIds(req, context) || []);
      if (current.visits.some((visit) => !managed.has(visit.siteId))) {
        return res.status(403).json({ message: 'لا تملك صلاحية إدارة نطاق هذه الجولة' });
      }
    }

    const isSystemAdmin = req.authUser?.role === 'admin';
    const isOwner = current.createdBy === req.authUser?.id;
    if (!isSystemAdmin && !isOwner) {
      return res.status(403).json({ message: 'لا يمكن حذف الجولة إلا بواسطة المستخدم الذي أنشأها أو مسؤول المنصة' });
    }

    const hasStarted = current.status !== 'scheduled' || current.visits.some(fieldVisitHasExecutionData);
    if (!isSystemAdmin && hasStarted) {
      return res.status(409).json({ message: 'بدأ تنفيذ هذه الجولة أو أصبحت جزءًا من السجل التاريخي؛ استخدم «إلغاء الجولة» بدل الحذف.' });
    }

    const visitIds = current.visits.map((visit) => visit.id);
    await prisma.$transaction(async (tx) => {
      if (visitIds.length) await tx.mosqueFieldVisitItem.deleteMany({ where: { visitId: { in: visitIds } } });
      await tx.mosqueFieldVisit.deleteMany({ where: { tourId: current.id } });
      await tx.mosqueFieldTour.delete({ where: { id: current.id } });
    });

    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action: 'DELETE_MOSQUE_FIELD_TOUR',
        module: 'mosques',
        entity: 'MosqueFieldTour',
        entityId: current.id,
        entityLabel: current.tourNumber,
        description: \`حذف الجولة الميدانية \${current.tourNumber}: \${current.title}\`,
        details: { createdBy: current.createdBy, visitCount: current.visits.length, forcedBySystemAdmin: isSystemAdmin, previousStatus: current.status },
      } });
    } catch (auditError) {
      console.warn('Unable to audit field tour deletion:', auditError?.message || auditError);
    }

    res.status(204).send();
  } catch (error) { next(error); }
});

router.get('/field-visits/summary',`,
'unique: protect tour cancellation and add tour delete',
);

replaceOnce(
`    res.json(records);
  } catch (error) { next(error); }
});

router.get('/field-visits/:id',`,
`    res.json(records.map((record) => ({ ...record, ...fieldVisitAccessState(req, record) })));
  } catch (error) { next(error); }
});

router.get('/field-visits/:id',`,
'unique: decorate field visit list',
);

replaceOnce(
`    if (!record) return res.status(404).json({ message: 'الزيارة الميدانية غير موجودة' });
    res.json(record);
  } catch (error) { next(error); }
});

router.post('/field-visits',`,
`    if (!record) return res.status(404).json({ message: 'الزيارة الميدانية غير موجودة' });
    res.json({ ...record, ...fieldVisitAccessState(req, record) });
  } catch (error) { next(error); }
});

router.post('/field-visits',`,
'unique: decorate single field visit',
);

replaceOnce(
`router.delete('/field-visits/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const current = await prisma.mosqueFieldVisit.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!current) return res.status(404).json({ message: 'الزيارة الميدانية غير موجودة' });

    await prisma.mosqueFieldVisit.delete({ where: { id: current.id } });
    res.status(204).send();
  } catch (error) { next(error); }
});
`,
`router.delete('/field-visits/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const context = req.mosqueRole || await getModuleRole(req);
    const current = await prisma.mosqueFieldVisit.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          select: {
            id: true,
            status: true,
            note: true,
            responsibleEntity: true,
            dueDate: true,
            resolutionStatus: true,
            resolutionNote: true,
            beforeImages: true,
            afterImages: true,
          },
        },
      },
    });
    if (!current) return res.status(404).json({ message: 'الزيارة الميدانية غير موجودة' });
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, current.siteId, context);

    const isSystemAdmin = req.authUser?.role === 'admin';
    const isOwner = current.createdBy === req.authUser?.id;
    if (!isSystemAdmin && !isOwner) {
      return res.status(403).json({ message: 'لا يمكن حذف الزيارة إلا بواسطة المستخدم الذي أنشأها أو مسؤول المنصة' });
    }
    if (!isSystemAdmin && fieldVisitHasExecutionData(current)) {
      return res.status(409).json({ message: 'بدأ تنفيذ هذه الزيارة أو أصبحت جزءًا من السجل التاريخي؛ أغلق الزيارة أو ألغِ الجولة المرتبطة بدل حذف السجل.' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.mosqueFieldVisitItem.deleteMany({ where: { visitId: current.id } });
      await tx.mosqueFieldVisit.delete({ where: { id: current.id } });
    });
    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action: 'DELETE_MOSQUE_FIELD_VISIT',
        module: 'mosques',
        entity: 'MosqueFieldVisit',
        entityId: current.id,
        entityLabel: current.visitNumber,
        description: \`حذف الزيارة الميدانية \${current.visitNumber}\`,
        details: { createdBy: current.createdBy, tourId: current.tourId, siteId: current.siteId, forcedBySystemAdmin: isSystemAdmin },
      } });
    } catch (auditError) {
      console.warn('Unable to audit field visit deletion:', auditError?.message || auditError);
    }
    res.status(204).send();
  } catch (error) { next(error); }
});
`,
'unique: protect field visit deletion',
);

fs.writeFileSync(path, source);
console.log('Applied mosque field tour and visit ownership protection.');
