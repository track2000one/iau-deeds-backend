import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

const cleanString = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const sanitizePayload = (body = {}) => ({
  title: cleanString(body.title) || 'ملف مؤرشف',
  category: cleanString(body.category) || 'عام',
  documentNumber: cleanString(body.documentNumber),
  documentDate: cleanString(body.documentDate),
  documentDateType:
    body.documentDateType === 'hijri' ? 'hijri' : 'gregorian',
  issuingAuthority: cleanString(body.issuingAuthority),
  confidentiality: ['public', 'internal', 'confidential'].includes(
    body.confidentiality
  )
    ? body.confidentiality
    : 'internal',
  tags: cleanString(body.tags),
  description: cleanString(body.description),
  fileName: cleanString(body.fileName) || cleanString(body.originalName) || 'file',
  originalName: cleanString(body.originalName),
  mimeType: cleanString(body.mimeType),
  fileSize:
    body.fileSize === '' || body.fileSize === undefined || body.fileSize === null
      ? 0
      : Number(body.fileSize) || 0,
  driveUrl: cleanString(body.driveUrl),
  driveFileId: cleanString(body.driveFileId),
  createdBy: cleanString(body.createdBy),
});

router.get('/', async (_req, res, next) => {
  try {
    const documents = await prisma.archiveDocument.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    res.json(documents);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const document = await prisma.archiveDocument.findUnique({
      where: { id: req.params.id },
    });

    if (!document) {
      return res.status(404).json({ message: 'ملف الأرشفة غير موجود' });
    }

    res.json(document);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const data = sanitizePayload(req.body);

    if (!data.driveUrl) {
      return res.status(400).json({ message: 'رابط Google Drive مطلوب' });
    }

    const document = await prisma.archiveDocument.create({ data });
    res.status(201).json(document);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const data = sanitizePayload(req.body);

    if (!data.driveUrl) {
      return res.status(400).json({ message: 'رابط Google Drive مطلوب' });
    }

    const document = await prisma.archiveDocument.update({
      where: { id: req.params.id },
      data,
    });

    res.json(document);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.archiveDocument.delete({
      where: { id: req.params.id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
