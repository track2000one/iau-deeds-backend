import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import { reconcileEvidenceAuditMirror } from '../services/accountingEvidenceAuditReconciliation.service.js';

const router = Router();

const querySchema = z.object({
  detailLimit: z.coerce.number().int().min(0).max(2000).default(250),
});

const ensureAdmin = (req, res) => {
  if (req.authUser?.role === 'admin') return true;
  res.status(403).json({ message: 'مطابقة وإصلاح السجل الرقابي متاحان لمسؤول النظام فقط.' });
  return false;
};

router.get('/evidence-audit/reconciliation', async (req, res, next) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const query = querySchema.parse(req.query);
    const result = await reconcileEvidenceAuditMirror(prisma, {
      repairMissing: false,
      detailLimit: query.detailLimit,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/evidence-audit/reconciliation/backfill', async (req, res, next) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const input = querySchema.parse(req.body || {});
    const result = await reconcileEvidenceAuditMirror(prisma, {
      repairMissing: true,
      detailLimit: input.detailLimit,
    });

    await createAuditLog({
      user: req.authUser,
      action: 'evidence_audit_reconciliation_backfill',
      module: 'accounting_transformation',
      entity: 'accounting_evidence_reconciliation',
      entityId: 'global',
      entityLabel: 'مطابقة سجل مستندات الإثبات مع AuditLog',
      status: result.status === 'ok' ? 'success' : 'warning',
      description: `تم فحص ${result.expectedEvents} حدثًا رقابيًا، واستكمال ${result.repaired} نسخة مرآة مفقودة.`,
      newData: {
        recordsScanned: result.recordsScanned,
        expectedEvents: result.expectedEvents,
        verified: result.verified,
        missingBeforeRepair: result.missingBeforeRepair,
        repaired: result.repaired,
        remainingMissing: result.remainingMissing,
        mismatched: result.mismatched,
        auditOnly: result.auditOnly,
        reconciliationStatus: result.status,
      },
      metadata: {
        protectedEvidenceAudit: true,
        operation: 'safe_missing_only_backfill',
        checkedAt: result.checkedAt,
      },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
