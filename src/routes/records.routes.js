import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

const resources = {
  'allocated-lands': prisma.allocatedLand,
  'delivered-lands': prisma.deliveredLand,
  'leased-lands-out': prisma.leasedLandOut,
  'leased-lands-in': prisma.leasedLandIn,
  'leased-buildings-out': prisma.leasedBuildingOut,
  'leased-buildings-in': prisma.leasedBuildingIn,
};

const dateFields = new Set(['deliveryDate', 'contractStartDate']);
const numberFields = new Set(['area', 'rentAmount']);

const sanitizePayload = (body = {}) => {
  const data = { ...body };
  delete data.id;
  delete data.createdAt;
  delete data.updatedAt;

  for (const field of dateFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      data[field] = data[field] ? new Date(data[field]) : null;
    }
  }

  for (const field of numberFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      data[field] = data[field] === '' || data[field] == null ? null : Number(data[field]);
    }
  }

  return data;
};

const getDelegate = (req, res) => {
  const delegate = resources[req.params.resource];
  if (!delegate) {
    res.status(404).json({ message: 'نوع السجل غير مدعوم' });
    return null;
  }
  return delegate;
};

router.get('/:resource', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;
    const records = await delegate.findMany({ orderBy: { updatedAt: 'desc' } });
    res.json(records);
  } catch (error) {
    next(error);
  }
});

router.post('/:resource', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;
    const record = await delegate.create({ data: sanitizePayload(req.body) });
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

router.put('/:resource/:id', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;
    const record = await delegate.update({
      where: { id: req.params.id },
      data: sanitizePayload(req.body),
    });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

router.delete('/:resource/:id', async (req, res, next) => {
  try {
    const delegate = getDelegate(req, res);
    if (!delegate) return;
    await delegate.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
