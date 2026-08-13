const fs = require('fs');
const path = 'src/routes/mosques.routes.js';
let s = fs.readFileSync(path, 'utf8');

// Accept the four explicit personnel roles. Keep legacy collaborator readable for existing data.
s = s.replace(
  "personnelRole: z.enum(['imam', 'muezzin', 'khateeb', 'collaborator']).optional().nullable(),",
  "personnelRole: z.enum(['imam', 'muezzin', 'khateeb', 'collaborating_khateeb', 'collaborator']).optional().nullable(),"
);

// Validate direct personnel creation role.
const postPersonnelStart = s.indexOf("router.post('/personnel', requireRoles('head', 'supervisor'), async (req, res, next) => {");
if (postPersonnelStart < 0) throw new Error('personnel route missing');
const postPersonnelEnd = s.indexOf("\nrouter.get('/assignments'", postPersonnelStart);
if (postPersonnelEnd < 0) throw new Error('personnel route end missing');
const oldPersonnelBlock = s.slice(postPersonnelStart, postPersonnelEnd);
const newPersonnelBlock = `router.post('/personnel', requireRoles('head', 'supervisor'), async (req, res, next) => {\n  try {\n    const allowedPersonnelRoles = ['imam', 'muezzin', 'khateeb', 'collaborating_khateeb'];\n    const normalizedRole = String(req.body.role || 'imam').trim();\n    const data = {\n      siteId: String(req.body.siteId || ''), name: String(req.body.name || '').trim(), role: normalizedRole,\n      userId: nullableText(req.body.userId), mobile: nullableText(req.body.mobile), email: nullableText(req.body.email), notes: nullableText(req.body.notes), active: req.body.active !== false,\n    };\n    if (!data.siteId || data.name.length < 2) return res.status(400).json({ message: 'الموقع والاسم مطلوبان' });\n    if (!allowedPersonnelRoles.includes(data.role)) return res.status(400).json({ message: 'الصفة يجب أن تكون إمام أو مؤذن أو خطيب أو خطيب متعاون' });\n    if (data.userId) {\n      const existing = await prisma.mosquePersonnel.findFirst({ where: { userId: data.userId } });\n      if (existing) return res.status(409).json({ message: 'هذا المستخدم مرتبط مسبقًا بسجل منسوبي المساجد' });\n    }\n    res.status(201).json(await prisma.mosquePersonnel.create({ data }));\n  } catch (error) { next(error); }\n});\n`;
s = s.slice(0, postPersonnelStart) + newPersonnelBlock + s.slice(postPersonnelEnd);

// Replace assignment route to require precise personnel role + site and sync personnel record.
const assignStart = s.indexOf("router.put('/assignments/:userId', requireRoles('head'), async (req, res, next) => {");
if (assignStart < 0) throw new Error('assignment route missing');
const assignEnd = s.indexOf("\nrouter.get('/notifications'", assignStart);
if (assignEnd < 0) throw new Error('assignment route end missing');
const newAssignBlock = `router.put('/assignments/:userId', requireRoles('head'), async (req, res, next) => {\n  try {\n    const input = assignmentSchema.parse(req.body);\n    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });\n    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });\n\n    if (input.role === 'personnel') {\n      if (!input.siteId) return res.status(400).json({ message: 'يجب تحديد المسجد أو المصلى للمنسوب' });\n      if (!input.personnelRole) return res.status(400).json({ message: 'يجب تحديد الصفة: إمام أو مؤذن أو خطيب أو خطيب متعاون' });\n      if (input.personnelRole === 'collaborator') input.personnelRole = 'collaborating_khateeb';\n    } else {\n      input.personnelRole = null;\n    }\n\n    const assignment = await prisma.$transaction(async (tx) => {\n      const saved = await tx.mosqueUserAssignment.upsert({\n        where: { userId: req.params.userId },\n        create: { userId: req.params.userId, ...input },\n        update: input,\n        include: { site: { select: { name: true } } },\n      });\n\n      const existingPersonnel = await tx.mosquePersonnel.findFirst({ where: { userId: req.params.userId } });\n      if (input.role === 'personnel') {\n        const personnelData = {\n          siteId: input.siteId,\n          userId: req.params.userId,\n          name: user.username || user.email,\n          role: input.personnelRole,\n          email: user.email || null,\n          active: user.isActive !== false,\n        };\n        if (existingPersonnel) await tx.mosquePersonnel.update({ where: { id: existingPersonnel.id }, data: personnelData });\n        else await tx.mosquePersonnel.create({ data: personnelData });\n      } else if (existingPersonnel) {\n        await tx.mosquePersonnel.update({ where: { id: existingPersonnel.id }, data: { active: false } });\n      }\n      return saved;\n    });\n\n    res.json(assignment);\n  } catch (error) { next(error); }\n});\n`;
s = s.slice(0, assignStart) + newAssignBlock + s.slice(assignEnd);

fs.writeFileSync(path, s);
console.log('Updated mosque backend personnel role linkage');
