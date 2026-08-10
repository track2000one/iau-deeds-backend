import fs from 'node:fs';

const schemaPath = 'prisma/schema.prisma';
let schema = fs.readFileSync(schemaPath, 'utf8');
if (!schema.includes('model AssetExcelTemplate')) {
  schema += `\n\nmodel AssetExcelTemplate {\n  id           String   @id @default(cuid())\n  templateKey  String   @unique\n  title        String\n  fileName     String\n  driveFileId  String   @unique\n  driveUrl     String\n  mimeType     String?\n  fileSize     Float?\n  uploadedBy   String?\n  createdAt    DateTime @default(now())\n  updatedAt    DateTime @updatedAt\n\n  @@index([templateKey])\n  @@index([updatedAt])\n}\n`;
  fs.writeFileSync(schemaPath, schema);
}

const drivePath = 'src/services/googleDrive.js';
let drive = fs.readFileSync(drivePath, 'utf8');
if (!drive.includes('export async function downloadGoogleDriveFile')) {
  drive += `\n\nexport async function downloadGoogleDriveFile(fileId) {\n  if (!fileId) {\n    throw new Error('Google Drive file ID is required.');\n  }\n\n  const drive = getOAuthDriveClient();\n  const metadata = await drive.files.get({\n    fileId,\n    fields: 'id,name,mimeType,size',\n  });\n  const response = await drive.files.get(\n    { fileId, alt: 'media' },\n    { responseType: 'arraybuffer' }\n  );\n\n  return {\n    buffer: Buffer.from(response.data),\n    fileName: metadata.data.name || 'asset-template.xlsx',\n    mimeType: metadata.data.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',\n    size: metadata.data.size ? Number(metadata.data.size) : null,\n  };\n}\n`;
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
  const marker = 'const router = Router();';
  const block = `const router = Router();\n\nconst OFFICIAL_ASSET_TEMPLATE_KEY = 'official_assets_all';\nconst EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';\nconst officialExcelTemplateUpload = multer({\n  storage: multer.memoryStorage(),\n  limits: { fileSize: 15 * 1024 * 1024 },\n  fileFilter: (_req, file, cb) => {\n    const fileName = String(file.originalname || '').toLowerCase();\n    const allowed = file.mimetype === EXCEL_MIME || fileName.endsWith('.xlsx');\n    cb(allowed ? null : new Error('القالب الرسمي يجب أن يكون ملف Excel بصيغة XLSX.'), allowed);\n  },\n});`;
  routes = routes.replace(marker, block);
}

if (!routes.includes("router.get('/excel-template'")) {
  const insertionMarker = "router.get('/stats'";
  const idx = routes.indexOf(insertionMarker);
  if (idx < 0) throw new Error('assets stats route marker not found');
  const excelRoutes = `router.get('/excel-template', async (_req, res, next) => {\n  try {\n    const template = await prisma.assetExcelTemplate.findUnique({\n      where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY },\n    });\n    res.json(template || null);\n  } catch (error) { next(error); }\n});\n\nrouter.post('/excel-template', officialExcelTemplateUpload.single('file'), async (req, res, next) => {\n  try {\n    if (req.authUser?.role !== 'admin') {\n      return res.status(403).json({ message: 'رفع أو استبدال قالب Excel الرسمي متاح لمسؤول النظام فقط.' });\n    }\n    if (!req.file) return res.status(400).json({ message: 'لم يتم إرفاق قالب Excel.' });\n\n    const previous = await prisma.assetExcelTemplate.findUnique({\n      where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY },\n    });\n    const uploaded = await uploadBufferToGoogleDrive(req.file, {\n      fileName: 'official-assets-template.xlsx',\n      mimeType: EXCEL_MIME,\n    });\n    const uploadedBy = req.authUser?.username || req.authUser?.email || null;\n    const template = await prisma.assetExcelTemplate.upsert({\n      where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY },\n      update: {\n        title: 'نموذج الأصول الرسمي المعتمد',\n        fileName: req.file.originalname || uploaded.fileName,\n        driveFileId: uploaded.driveFileId,\n        driveUrl: uploaded.driveUrl,\n        mimeType: uploaded.mimeType || EXCEL_MIME,\n        fileSize: req.file.size || null,\n        uploadedBy,\n      },\n      create: {\n        templateKey: OFFICIAL_ASSET_TEMPLATE_KEY,\n        title: 'نموذج الأصول الرسمي المعتمد',\n        fileName: req.file.originalname || uploaded.fileName,\n        driveFileId: uploaded.driveFileId,\n        driveUrl: uploaded.driveUrl,\n        mimeType: uploaded.mimeType || EXCEL_MIME,\n        fileSize: req.file.size || null,\n        uploadedBy,\n      },\n    });\n\n    if (previous?.driveFileId && previous.driveFileId !== uploaded.driveFileId) {\n      deleteGoogleDriveFile(previous.driveFileId).catch((error) =>\n        console.warn('Could not delete previous asset Excel template:', error?.message || error)\n      );\n    }\n\n    await createAuditLog({\n      user: req.authUser,\n      action: previous ? 'update' : 'create',\n      module: 'assets',\n      entity: 'asset_excel_template',\n      entityId: template.id,\n      entityLabel: template.fileName,\n      description: previous ? 'استبدال قالب Excel الرسمي للأصول' : 'رفع قالب Excel الرسمي للأصول',\n      newData: template,\n      ipAddress: getClientIp(req),\n      userAgent: req.headers['user-agent'],\n    });\n\n    res.status(previous ? 200 : 201).json(template);\n  } catch (error) { next(error); }\n});\n\nrouter.get('/excel-template/file', async (_req, res, next) => {\n  try {\n    const template = await prisma.assetExcelTemplate.findUnique({\n      where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY },\n    });\n    if (!template) return res.status(404).json({ message: 'لم يتم رفع قالب Excel الرسمي للأصول بعد.' });\n    const downloaded = await downloadGoogleDriveFile(template.driveFileId);\n    const safeName = String(template.fileName || downloaded.fileName || 'official-assets-template.xlsx').replace(/[\\\"\r\n]/g, '_');\n    res.setHeader('Content-Type', EXCEL_MIME);\n    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);\n    res.setHeader('Cache-Control', 'private, no-store');\n    res.send(downloaded.buffer);\n  } catch (error) { next(error); }\n});\n\n`;
  routes = routes.slice(0, idx) + excelRoutes + routes.slice(idx);
}
fs.writeFileSync(routesPath, routes);

console.log('Official asset Excel template backend support applied.');
// trigger 2026-08-10T14:12+03:00
