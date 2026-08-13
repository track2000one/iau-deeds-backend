from pathlib import Path

path = Path('src/routes/mosques.routes.js')
s = path.read_text(encoding='utf-8')

replacements = [
    (
        "router.post('/requests', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {",
        "router.post('/requests', requireRoles('personnel'), async (req, res, next) => {",
    ),
    (
        "router.post('/leaves', requireRoles('head', 'supervisor', 'personnel'), async (req, res, next) => {",
        "router.post('/leaves', requireRoles('personnel'), async (req, res, next) => {",
    ),
]

for old, new in replacements:
    if old not in s:
        raise RuntimeError(f'anchor not found: {old}')
    s = s.replace(old, new, 1)

old_request_guard = """    if (context.role === 'personnel') {\n      if (!context.siteId || input.siteId !== context.siteId) return res.status(403).json({ message: 'يمكن لمنسوب المسجد تقديم الطلب للموقع المرتبط بحسابه فقط' });\n    }\n    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, context);\n"""
new_request_guard = """    if (!context.siteId || input.siteId !== context.siteId) {\n      return res.status(403).json({ message: 'يمكن لمنسوب المسجد تقديم الطلب للمسجد أو الجامع أو المصلى المرتبط بحسابه فقط' });\n    }\n"""
if old_request_guard not in s:
    raise RuntimeError('request guard anchor not found')
s = s.replace(old_request_guard, new_request_guard, 1)

old_request_notify = """    await notify({ roleTarget: 'supervisor', siteId: input.siteId, title: 'طلب جديد', message: `تم إنشاء الطلب ${request.requestNumber}${site?.name ? ` - ${site.name}` : ''}`, entityType: 'request', entityId: request.id });\n    res.status(201).json(request);\n"""
new_request_notify = """    await Promise.all([\n      notify({ roleTarget: 'supervisor', siteId: input.siteId, title: 'طلب صيانة/احتياج جديد', message: `تم استلام الطلب ${request.requestNumber}${site?.name ? ` - ${site.name}` : ''}`, entityType: 'request', entityId: request.id }),\n      notify({ roleTarget: 'head', siteId: input.siteId, title: 'طلب صيانة/احتياج جديد', message: `تم استلام الطلب ${request.requestNumber}${site?.name ? ` - ${site.name}` : ''}`, entityType: 'request', entityId: request.id }),\n    ]);\n    res.status(201).json(request);\n"""
if old_request_notify not in s:
    raise RuntimeError('request notification anchor not found')
s = s.replace(old_request_notify, new_request_notify, 1)

old_leave_guard = """    const context = req.mosqueRole || await getModuleRole(req);\n    if (context.role === 'personnel' && (!context.siteId || input.siteId !== context.siteId)) return res.status(403).json({ message: 'الموقع غير مرتبط بحسابك' });\n    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, context);\n"""
new_leave_guard = """    const context = req.mosqueRole || await getModuleRole(req);\n    if (!context.siteId || input.siteId !== context.siteId) {\n      return res.status(403).json({ message: 'يمكن لمنسوب المسجد تقديم الإجازة أو الاعتذار للموقع المرتبط بحسابه فقط' });\n    }\n"""
if old_leave_guard not in s:
    raise RuntimeError('leave guard anchor not found')
s = s.replace(old_leave_guard, new_leave_guard, 1)

old_leave_notify = """    await notify({ roleTarget: 'supervisor', siteId: input.siteId, title: 'طلب إجازة/اعتذار', message: `طلب جديد ${leave.leaveNumber}`, entityType: 'leave', entityId: leave.id });\n    res.status(201).json(leave);\n"""
new_leave_notify = """    const leaveSite = await prisma.mosqueSite.findUnique({ where: { id: input.siteId }, select: { name: true } });\n    await Promise.all([\n      notify({ roleTarget: 'supervisor', siteId: input.siteId, title: 'طلب إجازة/اعتذار جديد', message: `تم استلام ${leave.leaveNumber}${leaveSite?.name ? ` - ${leaveSite.name}` : ''}`, entityType: 'leave', entityId: leave.id }),\n      notify({ roleTarget: 'head', siteId: input.siteId, title: 'طلب إجازة/اعتذار جديد', message: `تم استلام ${leave.leaveNumber}${leaveSite?.name ? ` - ${leaveSite.name}` : ''}`, entityType: 'leave', entityId: leave.id }),\n    ]);\n    res.status(201).json(leave);\n"""
if old_leave_notify not in s:
    raise RuntimeError('leave notification anchor not found')
s = s.replace(old_leave_notify, new_leave_notify, 1)

path.write_text(s, encoding='utf-8')
