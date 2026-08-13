from pathlib import Path

path = Path('src/routes/mosques.routes.js')
s = path.read_text(encoding='utf-8')
old = """const getModuleRole = async (req) => {\n  if (req.authUser?.role === 'admin') return { role: 'head', siteId: null, assignment: null };\n  const assignment = await prisma.mosqueUserAssignment.findUnique({ where: { userId: req.authUser.id } });\n  return assignment\n    ? { role: normalizeMosqueRole(assignment.role), siteId: assignment.siteId || null, assignment }\n    : { role: 'university_member', siteId: null, assignment: null };\n};\n"""
new = """const hasFullMosquePermission = (user) => {\n  const permission = user?.permissions?.find((item) => item.module === 'mosques');\n  return Boolean(\n    permission?.canView &&\n    permission?.canAdd &&\n    permission?.canEdit &&\n    permission?.canDelete &&\n    permission?.canPrint\n  );\n};\n\nconst getModuleRole = async (req) => {\n  if (req.authUser?.role === 'admin') {\n    return { role: 'head', siteId: null, assignment: null, fullPermissionAccess: true, accessSource: 'system_admin' };\n  }\n\n  const assignment = await prisma.mosqueUserAssignment.findUnique({ where: { userId: req.authUser.id } });\n\n  // صلاحيات الوحدة الكاملة تمنح نطاق إدارة شامل داخل وحدة المساجد،\n  // مع إبقاء المنصب التشغيلي الرسمي منفصلًا عن الصلاحية.\n  if (hasFullMosquePermission(req.authUser)) {\n    return {\n      role: 'head',\n      siteId: null,\n      assignment,\n      fullPermissionAccess: true,\n      accessSource: 'module_permissions',\n    };\n  }\n\n  return assignment\n    ? { role: normalizeMosqueRole(assignment.role), siteId: assignment.siteId || null, assignment, fullPermissionAccess: false, accessSource: 'assignment' }\n    : { role: 'university_member', siteId: null, assignment: null, fullPermissionAccess: false, accessSource: 'default' };\n};\n"""
if old not in s:
    raise RuntimeError('getModuleRole anchor not found')
s = s.replace(old, new, 1)
old_me = "res.json({ role: context.role, siteId: context.siteId, personnelRole: context.assignment?.personnelRole || null, userId: req.authUser.id, isAdmin: req.authUser.role === 'admin' });"
new_me = "res.json({ role: context.role, siteId: context.siteId, personnelRole: context.assignment?.personnelRole || null, userId: req.authUser.id, isAdmin: req.authUser.role === 'admin', fullPermissionAccess: Boolean(context.fullPermissionAccess), accessSource: context.accessSource || 'assignment' });"
if old_me not in s:
    raise RuntimeError('/me response anchor not found')
s = s.replace(old_me, new_me, 1)
path.write_text(s, encoding='utf-8')
