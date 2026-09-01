from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')

anchor = """const fieldSiteScope = async (req, context) => {
  const managedSiteIds = await getManagedSiteIds(req, context);
  return managedSiteIds === null ? {} : { siteId: { in: managedSiteIds } };
};
"""
insert = anchor + """
const ACTIVE_FIELD_VISIT_STATUSES = ['planned', 'in_progress', 'follow_up'];
const findActiveFieldVisitConflict = async (siteIds, ignoreVisitId = null) => {
  const records = await prisma.mosqueFieldVisit.findMany({
    where: {
      siteId: { in: siteIds },
      workflowStatus: { in: ACTIVE_FIELD_VISIT_STATUSES },
      ...(ignoreVisitId ? { id: { not: ignoreVisitId } } : {}),
    },
    select: {
      id: true,
      visitNumber: true,
      siteId: true,
      workflowStatus: true,
      site: { select: { id: true, name: true } },
      tour: { select: { id: true, tourNumber: true, title: true, status: true } },
    },
    orderBy: [{ visitDate: 'desc' }, { createdAt: 'desc' }],
  });
  return records.find((record) => record.tour?.status !== 'cancelled') || null;
};
const activeFieldVisitMessage = (record) => `يوجد إجراء ميداني قائم للموقع ${record.site.name} برقم ${record.visitNumber} وحالته الحالية ${record.workflowStatus === 'planned' ? 'مجدولة' : record.workflowStatus === 'in_progress' ? 'جارية' : 'تحتاج متابعة'}. افتح الزيارة القائمة بدل إنشاء زيارة مكررة.`;
"""
if 'const ACTIVE_FIELD_VISIT_STATUSES' not in text:
    if anchor not in text:
        raise SystemExit('fieldSiteScope anchor not found')
    text = text.replace(anchor, insert, 1)

anchor = """    const sites = await prisma.mosqueSite.findMany({ where: { id: { in: siteIds } }, select: { id: true } });
    if (sites.length !== siteIds.length) return res.status(400).json({ message: 'يتضمن نطاق الجولة مسجدًا أو مصلى غير موجود' });

    const created = await prisma.$transaction(async (tx) => {
"""
replacement = """    const sites = await prisma.mosqueSite.findMany({ where: { id: { in: siteIds } }, select: { id: true } });
    if (sites.length !== siteIds.length) return res.status(400).json({ message: 'يتضمن نطاق الجولة مسجدًا أو مصلى غير موجود' });

    const conflict = await findActiveFieldVisitConflict(siteIds);
    if (conflict) {
      return res.status(409).json({
        message: activeFieldVisitMessage(conflict),
        conflict: { visitId: conflict.id, visitNumber: conflict.visitNumber, siteId: conflict.siteId, siteName: conflict.site.name, workflowStatus: conflict.workflowStatus },
      });
    }

    const created = await prisma.$transaction(async (tx) => {
"""
if 'const conflict = await findActiveFieldVisitConflict(siteIds);' not in text:
    if anchor not in text:
        raise SystemExit('field tour conflict anchor not found')
    text = text.replace(anchor, replacement, 1)

anchor = """    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });
    const items = input.items.length ? input.items : newFieldChecklist();
"""
replacement = """    const site = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { id: true } });
    if (!site) return res.status(404).json({ message: 'المسجد أو المصلى غير موجود' });
    const conflict = await findActiveFieldVisitConflict([input.siteId]);
    if (conflict) {
      return res.status(409).json({
        message: activeFieldVisitMessage(conflict),
        conflict: { visitId: conflict.id, visitNumber: conflict.visitNumber, siteId: conflict.siteId, siteName: conflict.site.name, workflowStatus: conflict.workflowStatus },
      });
    }
    const items = input.items.length ? input.items : newFieldChecklist();
"""
if "findActiveFieldVisitConflict([input.siteId])" not in text:
    if anchor not in text:
        raise SystemExit('field visit create conflict anchor not found')
    text = text.replace(anchor, replacement, 1)

anchor = """    const input = fieldVisitSchema.parse(req.body);
    const record = await prisma.$transaction(async (tx) => {
"""
replacement = """    const input = fieldVisitSchema.parse(req.body);
    if (ACTIVE_FIELD_VISIT_STATUSES.includes(input.workflowStatus)) {
      const conflict = await findActiveFieldVisitConflict([input.siteId], current.id);
      if (conflict) {
        return res.status(409).json({
          message: activeFieldVisitMessage(conflict),
          conflict: { visitId: conflict.id, visitNumber: conflict.visitNumber, siteId: conflict.siteId, siteName: conflict.site.name, workflowStatus: conflict.workflowStatus },
        });
      }
    }
    const record = await prisma.$transaction(async (tx) => {
"""
if "findActiveFieldVisitConflict([input.siteId], current.id)" not in text:
    if anchor not in text:
        raise SystemExit('field visit update conflict anchor not found')
    text = text.replace(anchor, replacement, 1)

path.write_text(text, encoding='utf-8')
print('Field visit duplicate guard applied')
