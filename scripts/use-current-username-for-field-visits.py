from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')

old = """router.get('/me', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    res.json({ role: context.role, siteId: context.siteId, personnelRole: context.assignment?.personnelRole || null, userId: req.authUser.id, isAdmin: req.authUser.role === 'admin', fullPermissionAccess: Boolean(context.fullPermissionAccess), accessSource: context.accessSource || 'assignment' });
  } catch (error) { next(error); }
});"""
new = """router.get('/me', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    const currentUser = await prisma.appUser.findUnique({
      where: { id: req.authUser.id },
      select: { username: true },
    });
    res.json({
      role: context.role,
      siteId: context.siteId,
      personnelRole: context.assignment?.personnelRole || null,
      userId: req.authUser.id,
      username: currentUser?.username || req.authUser?.username || 'مستخدم',
      isAdmin: req.authUser.role === 'admin',
      fullPermissionAccess: Boolean(context.fullPermissionAccess),
      accessSource: context.accessSource || 'assignment',
    });
  } catch (error) { next(error); }
});"""

if "username: currentUser?.username" not in text:
    if old not in text:
        raise SystemExit('me route anchor not found')
    text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
print('Mosque /me now returns current username')
