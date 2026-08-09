import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const deedSchema = z.object({
  propertyDescription: z.string().min(1, 'بيان العقار مطلوب'),
  usageType: z.string().default('other'),
  deedNumber: z.string().min(1, 'رقم الصك مطلوب'),
  deedDate: z.string().optional().nullable(),
  deedDateType: z.enum(['gregorian', 'hijri']).optional().default('gregorian'),
  plotNumber: z.string().optional().nullable(),
  planNumber: z.string().optional().nullable(),
  area: z.coerce.number().optional().default(0),
  location: z.string().optional().nullable(),
  coordinates: z.string().optional().nullable(),
  isPlanned: z.coerce.boolean().optional().default(false),
  city: z.string().optional().nullable(),
  district: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable(),
});

const parseFlexibleDate = (value, type = 'gregorian', fieldName = 'التاريخ') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (!match) {
      const error = new Error(`${fieldName} الهجري غير صحيح`);
      error.status = 400;
      throw error;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 30) {
      const error = new Error(`${fieldName} الهجري غير صحيح`);
      error.status = 400;
      throw error;
    }
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName} الميلادي غير صحيح`);
    error.status = 400;
    throw error;
  }
  return parsed;
};

const toDbData = (body) => {
  const data = deedSchema.parse(body);
  return {
    ...data,
    deedDate: parseFlexibleDate(data.deedDate, data.deedDateType, 'تاريخ الصك'),
  };
};

router.get('/', async (req, res, next) => {
  try {
    const deeds = await prisma.deed.findMany({
      orderBy: { updatedAt: 'desc' },
    });
    res.json(deeds);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const deed = await prisma.deed.findUnique({
      where: { id: req.params.id },
    });
    if (!deed) return res.status(404).json({ message: 'الصك غير موجود' });
    res.json(deed);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const deed = await prisma.deed.create({ data: toDbData(req.body) });
    res.status(201).json(deed);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const deed = await prisma.deed.update({
      where: { id: req.params.id },
      data: toDbData(req.body),
    });
    res.json(deed);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.deed.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
