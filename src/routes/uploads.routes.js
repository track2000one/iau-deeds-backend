import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import {
  uploadBufferToGoogleDrive,
  deleteGoogleDriveFile,
  downloadGoogleDriveFile,
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
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'video/mp4',
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      cb(new Error('نوع الملف غير مسموح. المسموح: JPG, PNG, WEBP, GIF, PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, MP4'));
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
      'investment_site',
      'investment_area',
      'transaction_follow_up',
    ])
    .optional(),
  entityId: z.string().optional(),
  attachmentType: z
    .enum([
      'deed_image',
      'survey_document',
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

    // For direct uploads from an existing deed, reject invalid IDs before creating
    // files in Drive. Other legacy upload flows remain unchanged.
    if (parsed.entityType === 'deed' && parsed.entityId) {
      const deed = await prisma.deed.findUnique({
        where: { id: parsed.entityId },
        select: { id: true },
      });
      if (!deed) {
        return res.status(404).json({ message: 'الصك المطلوب غير موجود، ولم يتم رفع الملف.' });
      }
    }

    const uploaded = await uploadBufferToGoogleDrive(req.file, {
      fileName: req.body.fileName,
    });

    let attachment = null;

    if (parsed.entityType && parsed.entityId) {
      try {
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
            createdBy: req.authUser?.id || parsed.createdBy || null,
          },
        });
      } catch (error) {
        // Prevent orphaned Drive files if the database record cannot be saved.
        if (uploaded.driveFileId) {
          try {
            await deleteGoogleDriveFile(uploaded.driveFileId);
          } catch (cleanupError) {
            console.error('Unable to remove orphaned Drive upload:', cleanupError);
          }
        }
        throw error;
      }
    }

    res.status(201).json({
      ...uploaded,
      attachment,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:fileId/content', async (req, res, next) => {
  try {
    const file = await downloadGoogleDriveFile(req.params.fileId);
    const encodedName = encodeURIComponent(file.fileName || 'attachment');

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (file.size) res.setHeader('Content-Length', String(file.size));
    res.status(200).send(file.buffer);
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