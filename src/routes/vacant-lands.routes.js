import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const status = z.enum([
  'DRAFT',
  'UNDER_REVIEW',
  'VERIFIED_VACANT',
  'PARTIALLY_OCCUPIED',
  'OCCUPIED',
  'ALLOCATED',
]);

const optionalText = (max = 2000) => z.string().trim().max(max).optional().nullable();
const optionalNumber = (min, max) =>
  z.union([z.number(), z.null()])
    .optional()
    .refine((v) => v == null || (Number.isFinite(v) && v >= min && v <= max),
      'القيمة الرقمية خارج النطاق المسموح');

const schema = z.object({
  code: z.string().trim().min(2).max(70).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(250),
  campus: z.string().trim().min(2).max(250),
  deedId: z.string().trim().min(1),
  locationDescription: optionalText(1200),
  approximateArea: z.number().positive().max(1e12),
  verifiedVacantArea: optionalNumber(0, 1e12),
  status: status.default('DRAFT'),
  currentUse: optionalText(500),
  allocationPurpose: optionalText(500),
  latitude: optionalNumber(-90, 90),
  longitude: optionalNumber(-180, 180),
  inspectionDate: z.coerce.date().optional().nullable(),
  inspectionNote: optionalText(3000),
  notes: optionalText(4000),
}).strict().superRefine((v, ctx) => {
  if (v.verifiedVacantArea != null && v.verifiedVacantArea > v.approximateArea) {
    ctx.addIssue({ code: 'custom', path: ['verifiedVacantArea'],
      message: 'المساحة الشاغرة المعتمدة لا يمكن أن تتجاوز مساحة الموقع' });
  }
  if (v.status === 'VERIFIED_VACANT' && v.verifiedVacantArea == null) {
    ctx.addIssue({ code: 'custom', path: ['verifiedVacantArea'],
      message: 'يجب إدخال المساحة الشاغرة المؤكدة قبل الاعتماد' });
  }
});

const detail = { deed: { select: { id: true, deedNumber: true, propertyDescription: true, area: true } } };
const actor = (req) => ({ id: req.authUser?.id || null, name: req.authUser?.username || null });
const isAdmin = (req) => req.authUser?.role === 'admin';

const replyError = (err, res, next) => {
  if (err?.code === 'P2002') return res.status(409).json({ message: 'رمز الموقع مستخدم مسبقًا' });
  if (err?.code === 'P2003') return res.status(400).json({ message: 'ارتباط الصك غير صحيح' });
  if (err?.name === 'ZodError') return res.status(400).json({ message: 'بيانات الموقع غير صحيحة', issues: err.issues });
  return next(err);
};

const assertDeed = async (deedId, res) => {
  const deed = await prisma.deed.findUnique({ where: { id: deedId }, select: { id: true, area: true } });
  if (!deed) { res.status(400).json({ message: 'يجب ربط الموقع بصك موجود في سجل الصكوك' }); return false; }
  return true;
};

router.get('/deed-options', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const items = await prisma.deed.findMany({
      where: q ? { OR: [
        { deedNumber: { contains: q, mode: 'insensitive' } },
        { propertyDescription: { contains: q, mode: 'insensitive' } },
      ] } : {},
      select: { id: true, deedNumber: true, propertyDescription: true, area: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    res.json(items);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const campus = String(req.query.campus || '').trim().slice(0, 250);
    const filterStatus = String(req.query.status || '').trim();
    if (filterStatus && !status.safeParse(filterStatus).success) {
      return res.status(400).json({ message: 'حالة الإشغال غير صحيحة' });
    }
    const items = await prisma.vacantLand.findMany({
      where: {
        ...(campus ? { campus } : {}),
        ...(filterStatus ? { status: filterStatus } : {}),
        ...(q ? { OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { code: { contains: q, mode: 'insensitive' } },
          { campus: { contains: q, mode: 'insensitive' } },
          { deed: { deedNumber: { contains: q, mode: 'insensitive' } } },
        ] } : {}),
      },
      include: detail,
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });
    res.json(items);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const item = await prisma.vacantLand.findUnique({ where: { id: req.params.id }, include: detail });
    if (!item) return res.status(404).json({ message: 'الموقع غير موجود' });
    res.json(item);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = schema.parse(req.body);
    if (input.status === 'VERIFIED_VACANT' && !isAdmin(req)) {
      return res.status(403).json({ message: 'اعتماد الشغور متاح للمسؤول فقط' });
    }
    if (input.verifiedVacantArea != null && (input.status !== 'VERIFIED_VACANT' || !isAdmin(req))) {
      return res.status(403).json({ message: 'المساحة الشاغرة المعتمدة لا تسجل إلا بواسطة المسؤول عند التحقق' });
    }
    if (input.status === 'VERIFIED_VACANT' && !input.inspectionDate) {
      return res.status(400).json({ message: 'تاريخ المعاينة مطلوب قبل اعتماد الشغور' });
    }
    if (!(await assertDeed(input.deedId, res))) return;
    const who = actor(req);
    const item = await prisma.vacantLand.create({
      data: {
        ...input,
        createdById: who.id,
        createdByName: who.name,
        updatedById: who.id,
        updatedByName: who.name,
        ...(input.status === 'VERIFIED_VACANT' ? {
          verifiedById: who.id, verifiedByName: who.name, verifiedAt: new Date(),
        } : {}),
      },
      include: detail,
    });
    res.status(201).json(item);
  } catch (err) { replyError(err, res, next); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const current = await prisma.vacantLand.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الموقع غير موجود' });
    if (current.status === 'VERIFIED_VACANT' && !isAdmin(req)) {
      return res.status(403).json({ message: 'الموقع المعتمد لا يعدله إلا المسؤول' });
    }
    const input = schema.parse(req.body);
    if (input.status === 'VERIFIED_VACANT' && !isAdmin(req)) {
      return res.status(403).json({ message: 'اعتماد الشغور متاح للمسؤول فقط' });
    }
    if (input.verifiedVacantArea != null && (input.status !== 'VERIFIED_VACANT' || !isAdmin(req))) {
      return res.status(403).json({ message: 'المساحة الشاغرة المعتمدة لا تسجل إلا بواسطة المسؤول عند التحقق' });
    }
    if (input.status === 'VERIFIED_VACANT' && !input.inspectionDate) {
      return res.status(400).json({ message: 'تاريخ المعاينة مطلوب قبل اعتماد الشغور' });
    }
    if (!(await assertDeed(input.deedId, res))) return;
    const who = actor(req);
    const verified = input.status === 'VERIFIED_VACANT';
    const item = await prisma.vacantLand.update({
      where: { id: current.id },
      data: {
        ...input,
        updatedById: who.id,
        updatedByName: who.name,
        ...(
          verified
            ? { verifiedById: who.id, verifiedByName: who.name, verifiedAt: new Date() }
            : { verifiedById: null, verifiedByName: null, verifiedAt: null }
        ),
      },
      include: detail,
    });
    res.json(item);
  } catch (err) { replyError(err, res, next); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const current = await prisma.vacantLand.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الموقع غير موجود' });
    if (current.status === 'VERIFIED_VACANT' && !isAdmin(req)) {
      return res.status(403).json({ message: 'الموقع المعتمد لا يحذفه إلا المسؤول' });
    }
    await prisma.vacantLand.delete({ where: { id: current.id } });
    res.status(204).send();
  } catch (err) { replyError(err, res, next); }
});

export default router;
