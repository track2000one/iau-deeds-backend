import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';

const router = Router();

const updateSchema = z.object({
  contractKey: z.string().trim().min(1).max(300),
  status: z.enum(['not_started', 'in_progress', 'renewed', 'not_renewing', 'closed']).default('not_started'),
  assignedTo: z.string().trim().max(300).optional().nullable(),
  action: z.string().trim().max(1000).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  nextFollowUpDate: z.string().trim().optional().nullable(),
});

const parseDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error('تاريخ المتابعة غير صحيح');
    error.status = 400;
    throw error;
  }
  return parsed;
};

router.get('/', async (_req, res, next) => {
  try {
    const rows = await prisma.contractFollowUp.findMany({ orderBy: { updatedAt: 'desc' } });
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.put('/:contractKey', async (req, res, next) => {
  try {
    const input = updateSchema.parse({ ...req.body, contractKey: req.params.contractKey });
    const updatedBy = req.authUser?.username || req.authUser?.email || null;

    const record = await prisma.contractFollowUp.upsert({
      where: { contractKey: input.contractKey },
      update: {
        status: input.status,
        assignedTo: input.assignedTo || null,
        action: input.action || null,
        notes: input.notes || null,
        nextFollowUpDate: parseDate(input.nextFollowUpDate),
        updatedBy,
      },
      create: {
        contractKey: input.contractKey,
        status: input.status,
        assignedTo: input.assignedTo || null,
        action: input.action || null,
        notes: input.notes || null,
        nextFollowUpDate: parseDate(input.nextFollowUpDate),
        updatedBy,
      },
    });

    await createAuditLog({
      user: req.authUser,
      action: 'update',
      module: 'contracts_followup',
      entity: 'contract_followup',
      entityId: record.id,
      entityLabel: input.contractKey,
      description: 'تحديث متابعة عقد',
      newData: record,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.json(record);
  } catch (error) {
    next(error);
  }
});

export default router;
