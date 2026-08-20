import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import { deleteGoogleDriveFile, downloadGoogleDriveFile, uploadBufferToGoogleDrive } from '../services/googleDrive.js';
import {
  OFFICIAL_ACCOUNTING_TEMPLATE_KEY,
  getCurrentAccountingTemplateWithVersion,
  listAccountingTemplateVersions,
} from '../services/accountingTemplateVersions.service.js';

const router = Router();
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    const allowed = file.mimetype === EXCEL_MIME || fileName.endsWith('.xlsx');
    cb(allowed ? null : new Error('النموذج الرسمي يجب أن يكون ملف Excel بصيغة XLSX.'), allowed);
  },
});

const userLabel = (req) => req.authUser?.email || req.authUser?.username || null;

router.get('/excel-template', async (_req, res, next) => {
  try {
    res.json(await getCurrentAccountingTemplateWithVersion());
  } catch (error) { next(error); }
});

router.get('/excel-template/history', async (_req, res, next) => {
  try {
    res.json(await listAccountingTemplateVersions());
  } catch (error) { next(error); }
});

router.post('/excel-template', upload.single('file'), async (req, res, next) => {
  let uploaded = null;
  try {
    if (req.authUser?.role !== 'admin') return res.status(403).json({ message: 'رفع إصدار جديد من نموذج Excel الرسمي متاح لمسؤول النظام فقط.' });
    if (!req.file) return res.status(400).json({ message: 'لم يتم إرفاق نموذج Excel.' });

    const current = await getCurrentAccountingTemplateWithVersion();
    uploaded = await uploadBufferToGoogleDrive(req.file, {
      fileName: `official-accounting-transformation-template-${Date.now()}.xlsx`,
      mimeType: EXCEL_MIME,
    });
    const uploadedBy = userLabel(req);
    const nextVersion = current ? Number(current.versionNumber || 1) + 1 : 1;

    const template = await prisma.$transaction(async (tx) => {
      if (current) {
        await tx.assetExcelTemplate.update({
          where: { id: current.id },
          data: {
            templateKey: `${OFFICIAL_ACCOUNTING_TEMPLATE_KEY}:v${current.versionNumber}`,
            title: `نموذج التحول المحاسبي الرسمي — الإصدار ${current.versionNumber}`,
          },
        });
      }
      return tx.assetExcelTemplate.create({
        data: {
          templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY,
          title: `نموذج التحول المحاسبي الرسمي المعتمد — الإصدار ${nextVersion}`,
          fileName: req.file.originalname || uploaded.fileName,
          driveFileId: uploaded.driveFileId,
          driveUrl: uploaded.driveUrl,
          mimeType: uploaded.mimeType || EXCEL_MIME,
          fileSize: req.file.size || null,
          uploadedBy,
        },
      });
    });

    const response = { ...template, versionNumber: nextVersion, isCurrent: true };
    await createAuditLog({
      user: req.authUser,
      action: current ? 'create_version' : 'create',
      module: 'accounting_transformation',
      entity: 'accounting_excel_template',
      entityId: template.id,
      entityLabel: template.fileName,
      description: current
        ? `رفع إصدار جديد من النموذج الرسمي للتحول المحاسبي: الإصدار ${nextVersion}`
        : 'رفع أول إصدار من النموذج الرسمي للتحول المحاسبي',
      previousData: current,
      newData: response,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.status(current ? 200 : 201).json(response);
  } catch (error) {
    if (uploaded?.driveFileId) deleteGoogleDriveFile(uploaded.driveFileId).catch(() => {});
    next(error);
  }
});

const sendTemplateFile = async (template, res) => {
  if (!template) return res.status(404).json({ message: 'نموذج Excel المطلوب غير موجود.' });
  const downloaded = await downloadGoogleDriveFile(template.driveFileId);
  const safeName = String(template.fileName || downloaded.fileName || 'official-accounting-template.xlsx').replace(/[\"\r\n]/g, '_');
  res.setHeader('Content-Type', EXCEL_MIME);
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(safeName));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(downloaded.buffer);
};

router.get('/excel-template/file', async (_req, res, next) => {
  try {
    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY } });
    await sendTemplateFile(template, res);
  } catch (error) { next(error); }
});

router.get('/excel-template/:templateId/file', async (req, res, next) => {
  try {
    const template = await prisma.assetExcelTemplate.findUnique({ where: { id: req.params.templateId } });
    await sendTemplateFile(template, res);
  } catch (error) { next(error); }
});

export default router;
