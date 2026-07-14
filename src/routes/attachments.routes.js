import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const attachmentSchema = z.object({
  entityType: z.enum([
    'deed',
    'allocated_land',
    'delivered_land',
    'leased_land_out',
    'leased_land_in',
    'leased_building_out',
    'leased_building_in',
  ]),
  entityId: z.string().min(1),
  attachmentType: z.enum([
    'deed_image',
    'plan_image',
    'location_image',
    'contract_image',
    'delivery_minutes',
    'other',
  ]).default('other'),
  title: z.string().min(1, 'اسم المرفق مطلوب'),
  driveUrl: z.string().url('رابط Google Drive غير صحيح'),
  driveFileId: z.string().optional().nullable(),
  mimeType: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable(),
});

router.get('/:entityType/:entityId', async (req, res, next) => {
  try {
    const attachments = await prisma.attachment.findMany({
      where: {
        entityType: req.params.entityType,
        entityId: req.params.entityId,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(attachments);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const data = attachmentSchema.parse(req.body);
    const attachment = await prisma.attachment.create({ data });
    res.status(201).json(attachment);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.attachment.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
