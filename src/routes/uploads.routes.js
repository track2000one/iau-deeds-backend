import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import {
  uploadBufferToGoogleDrive,
  deleteGoogleDriveFile,
} from '../services/googleDrive.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/pdf',
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      cb(new Error('نوع الملف غير مسموح. المسموح: JPG, PNG, WEBP, GIF, PDF'));
      return;
    }

    cb(null, true);
  },
});

const uploadSchema = z.object({
  entityType: z
    .enum([
      'deed',
      'allocated_land',
      'delivered_land',
      'leased_land_out',
      'leased_land_in',
      'leased_building_out',
      'leased_building_in',
    ])
    .optional(),
  entityId: z.string().optional(),
  attachmentType: z
    .enum([
      'deed_image',
      'plan_image',
      'location_image',
      'contract_image',
      'delivery_minutes',
      'other',
    ])
    .default('other'),
  title: z.string().optional(),
  notes: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable(),
});

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    const parsed = uploadSchema.parse(req.body);

    if (!req.file) {
      res.status(400).json({ message: 'لم يتم إرفاق ملف.' });
      return;
    }

    const uploaded = await uploadBufferToGoogleDrive(req.file, {
      fileName: req.body.fileName,
    });

    let attachment = null;

    if (parsed.entityType && parsed.entityId) {
      attachment = await prisma.attachment.create({
        data: {
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          attachmentType: parsed.attachmentType,
          title: parsed.title || uploaded.fileName,
          driveUrl: uploaded.driveUrl,
          driveFileId: uploaded.driveFileId,
          mimeType: uploaded.mimeType,
          notes: parsed.notes || null,
          createdBy: parsed.createdBy || null,
        },
      });
    }

    res.status(201).json({
      ...uploaded,
      attachment,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:fileId', async (req, res, next) => {
  try {
    await deleteGoogleDriveFile(req.params.fileId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
