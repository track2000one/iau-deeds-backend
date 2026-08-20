import { Router } from 'express';
import { prisma } from '../prisma.js';

const router = Router();

const accountingPermission = (req) =>
  req.authUser?.permissions?.find((item) => item.module === 'accounting_transformation');

const canEditCycles = (req) =>
  req.authUser?.role === 'admin' || Boolean(accountingPermission(req)?.canEdit);

const canApproveCycles = (req) =>
  req.authUser?.role === 'admin' || Boolean(accountingPermission(req)?.canApproveCycle);

const normalizeReviewStatuses = async (cycleId) => {
  // A record that is byte-for-byte unchanged from the approved base cycle does
  // not need a second manual committee decision. We only auto-resolve statuses
  // that have not been explicitly marked as needing an update.
  const autoApproved = await prisma.accountingTransformationRecord.updateMany({
    where: {
      cycleId,
      changeType: 'unchanged',
      committeeStatus: { in: ['not_reviewed', 'under_review'] },
    },
    data: { committeeStatus: 'approved' },
  });

  // New/modified/manual records still require a human review. Moving them from
  // not_reviewed to under_review makes the workflow state explicit and avoids
  // the misleading situation where the whole cycle is under review but every
  // row is still shown as "not reviewed".
  const movedToReview = await prisma.accountingTransformationRecord.updateMany({
    where: {
      cycleId,
      changeType: { not: 'unchanged' },
      committeeStatus: 'not_reviewed',
    },
    data: { committeeStatus: 'under_review' },
  });

  return {
    autoApproved: autoApproved.count,
    movedToReview: movedToReview.count,
  };
};

const getReviewBreakdown = async (cycleId) => {
  const [notReviewed, underReview, needsUpdate, approved, completed] = await Promise.all([
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'not_reviewed' } }),
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'under_review' } }),
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'needs_update' } }),
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'approved' } }),
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'completed' } }),
  ]);

  return {
    notReviewed,
    underReview,
    needsUpdate,
    approved,
    completed,
    unresolved: notReviewed + underReview + needsUpdate,
  };
};

router.post('/:id/review', async (req, _res, next) => {
  try {
    if (!canEditCycles(req)) return next();

    const cycle = await prisma.accountingTransformationCycle.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, isCurrent: true },
    });
    if (!cycle || cycle.status !== 'draft' || cycle.isCurrent) return next();

    await normalizeReviewStatuses(cycle.id);
    return next();
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    // Do not mutate review states for a caller who is not allowed to approve;
    // the legacy cycle router will return the normal permission error.
    if (!canApproveCycles(req)) return next();

    const cycle = await prisma.accountingTransformationCycle.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, isCurrent: true },
    });
    if (!cycle || cycle.status !== 'under_review' || cycle.isCurrent) return next();

    const normalized = await normalizeReviewStatuses(cycle.id);
    const breakdown = await getReviewBreakdown(cycle.id);

    if (breakdown.unresolved > 0) {
      const details = [
        breakdown.underReview ? `${breakdown.underReview} تحت المراجعة` : null,
        breakdown.needsUpdate ? `${breakdown.needsUpdate} تحتاج تحديثًا` : null,
        breakdown.notReviewed ? `${breakdown.notReviewed} لم تبدأ مراجعتها` : null,
      ].filter(Boolean).join('، ');

      const autoText = normalized.autoApproved > 0
        ? ` تم اعتماد ${normalized.autoApproved} سجل بدون تغيير تلقائيًا من الدورة السابقة.`
        : '';

      return res.status(409).json({
        message: `لا يمكن اعتماد الدورة بعد: تبقى ${breakdown.unresolved} سجلًا تتطلب حسم المراجعة (${details}).${autoText} افتح «عرض البيانات» وراجع السجلات الجديدة أو المعدلة فقط.`,
        code: 'ACCOUNTING_CYCLE_REVIEW_PENDING',
        reviewSummary: {
          ...breakdown,
          autoApprovedNow: normalized.autoApproved,
          movedToReviewNow: normalized.movedToReview,
        },
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
});

export default router;
