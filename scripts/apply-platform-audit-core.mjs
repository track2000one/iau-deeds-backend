import fs from 'node:fs';

const replaceOnce = (source, before, after, label) => {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(before, after);
};

const appPath = 'src/app.js';
let app = fs.readFileSync(appPath, 'utf8');
app = replaceOnce(
  app,
  "app.use(\n  '/api/contracts/follow-up',\n  requireAuth,\n  auditTrail('contracts_followup'),\n  contractsFollowUpRoutes\n);",
  "app.use(\n  '/api/contracts/follow-up',\n  requireAuth,\n  auditTrail('contracts_followup'),\n  requirePermission('contracts_follow_up'),\n  contractsFollowUpRoutes\n);",
  'contracts follow-up permission guard',
);
fs.writeFileSync(appPath, app);

const uploadsPath = 'src/routes/uploads.routes.js';
let uploads = fs.readFileSync(uploadsPath, 'utf8');
uploads = replaceOnce(
  uploads,
  "          createdBy: parsed.createdBy || null,",
  "          createdBy: req.authUser?.username || req.authUser?.email || null,",
  'trusted upload creator identity',
);
fs.writeFileSync(uploadsPath, uploads);

const attachmentsPath = 'src/routes/attachments.routes.js';
let attachments = fs.readFileSync(attachmentsPath, 'utf8');
attachments = replaceOnce(
  attachments,
  "    const data = attachmentSchema.parse(req.body);\n    const attachment = await prisma.attachment.create({ data });",
  "    const data = attachmentSchema.parse(req.body);\n    const attachment = await prisma.attachment.create({\n      data: {\n        ...data,\n        createdBy: req.authUser?.username || req.authUser?.email || null,\n      },\n    });",
  'trusted attachment creator identity',
);
fs.writeFileSync(attachmentsPath, attachments);

console.log('Backend platform audit fixes applied.');
