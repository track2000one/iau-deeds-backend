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

const extractDriveFileId = (attachment) => {
  if (attachment?.driveFileId) return String(attachment.driveFileId);
  const rawUrl = String(attachment?.driveUrl || '').trim();
  if (!rawUrl) return '';

  try {
    const parsed = new URL(rawUrl);
    const queryId = parsed.searchParams.get('id');
    if (queryId) return queryId;
  } catch {}

  return rawUrl.match(/\/(?:file\/d|d)\/([^/?#]+)/)?.[1] || '';
};

const isApprovedAttachmentHost = (url) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'drive.google.com'
      || host === 'docs.google.com'
      || host.endsWith('.googleusercontent.com');
  } catch {
    return false;
  }
};

router.post('/deed-batch-manifest', async (req, res, next) => {
  try {
    const schema = z.object({
      deedIds: z.array(z.string().min(1)).min(1).max(1000),
    });
    const { deedIds } = schema.parse(req.body);

    const attachments = await prisma.attachment.findMany({
      where: {
        entityType: 'deed',
        entityId: { in: deedIds },
      },
      orderBy: [
        { entityId: 'asc' },
        { createdAt: 'asc' },
      ],
      select: {
        id: true,
        entityId: true,
        attachmentType: true,
        title: true,
        driveUrl: true,
        driveFileId: true,
        mimeType: true,
        createdAt: true,
      },
    });

    const grouped = Object.fromEntries(deedIds.map((deedId) => [deedId, []]));
    for (const attachment of attachments) {
      if (!grouped[attachment.entityId]) grouped[attachment.entityId] = [];
      grouped[attachment.entityId].push(attachment);
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    return res.json({
      totalAttachments: attachments.length,
      deedCount: deedIds.length,
      deedsWithAttachments: Object.values(grouped).filter((items) => items.length > 0).length,
      grouped,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/file/:id/content', async (req, res, next) => {
  try {
    const attachment = await prisma.attachment.findUnique({
      where: { id: req.params.id },
    });

    if (!attachment) {
      return res.status(404).json({ message: 'المرفق غير موجود' });
    }

    const originalUrl = String(attachment.driveUrl || '').trim();
    const fileId = extractDriveFileId(attachment);

    if (!fileId && !isApprovedAttachmentHost(originalUrl)) {
      return res.status(422).json({
        message: 'لا يمكن تمرير هذا المصدر عبر خادم المنصة. استخدم رابط Google Drive صالحًا.',
      });
    }

    const candidates = fileId
      ? [
          `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`,
          `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`,
          `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w4000`,
        ]
      : [originalUrl];

    let lastStatus = 502;

    for (const candidate of candidates) {
      if (!isApprovedAttachmentHost(candidate)) continue;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);

      try {
        const response = await fetch(candidate, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': 'IAU-Deeds/1.0',
            Accept: 'application/pdf,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
        });

        lastStatus = response.status || lastStatus;
        if (!response.ok) continue;

        const contentType = String(response.headers.get('content-type') || attachment.mimeType || '').toLowerCase();
        if (contentType.includes('text/html')) continue;

        const maxBytes = 35 * 1024 * 1024;
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > maxBytes) {
          return res.status(413).json({ message: 'حجم مستند الصك يتجاوز الحد المسموح للتجميع' });
        }

        const payload = Buffer.from(await response.arrayBuffer());
        if (!payload.length) continue;
        if (payload.length > maxBytes) {
          return res.status(413).json({ message: 'حجم صورة الصك يتجاوز الحد المسموح للتجميع' });
        }

        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        res.setHeader('Content-Length', String(payload.length));
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).send(payload);
      } catch (error) {
        if (error?.name !== 'AbortError') lastStatus = 502;
      } finally {
        clearTimeout(timeout);
      }
    }

    return res.status(lastStatus === 404 ? 404 : 502).json({
      message: 'تعذر تحميل مستند الصك من Google Drive. تحقق من صلاحية الرابط وإتاحة الملف.',
    });
  } catch (err) {
    next(err);
  }
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
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
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
