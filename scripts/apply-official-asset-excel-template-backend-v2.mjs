import fs from 'node:fs';

const schemaPath = 'prisma/schema.prisma';
let schema = fs.readFileSync(schemaPath, 'utf8');
if (!schema.includes('model AssetExcelTemplate')) {
  schema += [
    '', '', 'model AssetExcelTemplate {',
    '  id           String   @id @default(cuid())',
    '  templateKey  String   @unique',
    '  title        String',
    '  fileName     String',
    '  driveFileId  String   @unique',
    '  driveUrl     String',
    '  mimeType     String?',
    '  fileSize     Float?',
    '  uploadedBy   String?',
    '  createdAt    DateTime @default(now())',
    '  updatedAt    DateTime @updatedAt',
    '', '  @@index([templateKey])', '  @@index([updatedAt])', '}', ''
  ].join('\n');
  fs.writeFileSync(schemaPath, schema);
}

const drivePath = 'src/services/googleDrive.js';
let drive = fs.readFileSync(drivePath, 'utf8');
if (!drive.includes('export async function downloadGoogleDriveFile')) {
  drive += [
    '', '', 'export async function downloadGoogleDriveFile(fileId) {',
    "  if (!fileId) throw new Error('Google Drive file ID is required.');",
    '  const drive = getOAuthDriveClient();',
    "  const metadata = await drive.files.get({ fileId, fields: 'id,name,mimeType,size' });",
    "  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });",
    '  return {',
    '    buffer: Buffer.from(response.data),',
    "    fileName: metadata.data.name || 'asset-template.xlsx',",
    "    mimeType: metadata.data.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',",
    '    size: metadata.data.size ? Number(metadata.data.size) : null,',
    '  };',
    '}', ''
  ].join('\n');
  fs.writeFileSync(drivePath, drive);
}

const routesPath = 'src/routes/assets.routes.js';
let routes = fs.readFileSync(routesPath, 'utf8');
if (!routes.includes("import multer from 'multer';")) {
  routes = routes.replace("import { z } from 'zod';", "import { z } from 'zod';\nimport multer from 'multer';");
}
if (!routes.includes("from '../services/googleDrive.js'")) {
  routes = routes.replace(
    "import { createAuditLog, getClientIp } from '../services/audit.service.js';",
    "import { createAuditLog, getClientIp } from '../services/audit.service.js';\nimport { uploadBufferToGoogleDrive, deleteGoogleDriveFile, downloadGoogleDriveFile } from '../services/googleDrive.js';"
  );
}
if (!routes.includes('const officialExcelTemplateUpload')) {
  routes = routes.replace('const router = Router();', [
    'const router = Router();', '',
    "const OFFICIAL_ASSET_TEMPLATE_KEY = 'official_assets_all';",
    "const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';",
    'const officialExcelTemplateUpload = multer({',
    '  storage: multer.memoryStorage(),',
    '  limits: { fileSize: 15 * 1024 * 1024 },',
    '  fileFilter: (_req, file, cb) => {',
    "    const fileName = String(file.originalname || '').toLowerCase();",
    "    const allowed = file.mimetype === EXCEL_MIME || fileName.endsWith('.xlsx');",
    "    cb(allowed ? null : new Error('القالب الرسمي يجب أن يكون ملف Excel بصيغة XLSX.'), allowed);",
    '  },',
    '});'
  ].join('\n'));
}

if (!routes.includes("router.get('/excel-template'")) {
  const marker = "router.get('/stats'";
  const idx = routes.indexOf(marker);
  if (idx < 0) throw new Error('assets stats route marker not found');
  const block = [
    "router.get('/excel-template', async (_req, res, next) => {",
    '  try {',
    '    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });',
    '    res.json(template || null);',
    '  } catch (error) { next(error); }',
    '});', '',
    "router.post('/excel-template', officialExcelTemplateUpload.single('file'), async (req, res, next) => {",
    '  try {',
    "    if (req.authUser?.role !== 'admin') return res.status(403).json({ message: 'رفع أو استبدال قالب Excel الرسمي متاح لمسؤول النظام فقط.' });",
    "    if (!req.file) return res.status(400).json({ message: 'لم يتم إرفاق قالب Excel.' });",
    '    const previous = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });',
    "    const uploaded = await uploadBufferToGoogleDrive(req.file, { fileName: 'official-assets-template.xlsx', mimeType: EXCEL_MIME });",
    '    const uploadedBy = req.authUser?.username || req.authUser?.email || null;',
    '    const template = await prisma.assetExcelTemplate.upsert({',
    '      where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY },',
    '      update: { title: \'نموذج الأصول الرسمي المعتمد\', fileName: req.file.originalname || uploaded.fileName, driveFileId: uploaded.driveFileId, driveUrl: uploaded.driveUrl, mimeType: uploaded.mimeType || EXCEL_MIME, fileSize: req.file.size || null, uploadedBy },',
    '      create: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY, title: \'نموذج الأصول الرسمي المعتمد\', fileName: req.file.originalname || uploaded.fileName, driveFileId: uploaded.driveFileId, driveUrl: uploaded.driveUrl, mimeType: uploaded.mimeType || EXCEL_MIME, fileSize: req.file.size || null, uploadedBy },',
    '    });',
    '    if (previous?.driveFileId && previous.driveFileId !== uploaded.driveFileId) {',
    "      deleteGoogleDriveFile(previous.driveFileId).catch((error) => console.warn('Could not delete previous asset Excel template:', error?.message || error));",
    '    }',
    '    await createAuditLog({ user: req.authUser, action: previous ? \'update\' : \'create\', module: \'assets\', entity: \'asset_excel_template\', entityId: template.id, entityLabel: template.fileName, description: previous ? \'استبدال قالب Excel الرسمي للأصول\' : \'رفع قالب Excel الرسمي للأصول\', newData: template, ipAddress: getClientIp(req), userAgent: req.headers[\'user-agent\'] });',
    '    res.status(previous ? 200 : 201).json(template);',
    '  } catch (error) { next(error); }',
    '});', '',
    "router.get('/excel-template/file', async (_req, res, next) => {",
    '  try {',
    '    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });',
    "    if (!template) return res.status(404).json({ message: 'لم يتم رفع قالب Excel الرسمي للأصول بعد.' });",
    '    const downloaded = await downloadGoogleDriveFile(template.driveFileId);',
    "    const safeName = String(template.fileName || downloaded.fileName || 'official-assets-template.xlsx').replace(/[\\\"\\r\\n]/g, '_');",
    "    res.setHeader('Content-Type', EXCEL_MIME);",
    "    res.setHeader('Content-Disposition', \"attachment; filename*=UTF-8''\" + encodeURIComponent(safeName));",
    "    res.setHeader('Cache-Control', 'private, no-store');",
    '    res.send(downloaded.buffer);',
    '  } catch (error) { next(error); }',
    '});', '', ''
  ].join('\n');
  routes = routes.slice(0, idx) + block + routes.slice(idx);
}
fs.writeFileSync(routesPath, routes);
console.log('Official asset Excel template backend support applied v2.');
