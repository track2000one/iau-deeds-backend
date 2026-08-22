import { Router } from 'express';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';

const router = Router();

const accountingPermission = (req) =>
  req.authUser?.permissions?.find((item) => item.module === 'accounting_transformation');

const canEditCycles = (req) =>
  req.authUser?.role === 'admin' || Boolean(accountingPermission(req)?.canEdit);

const canApproveCycles = (req) =>
  req.authUser?.role === 'admin' || Boolean(accountingPermission(req)?.canApproveCycle);

const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== '';
const comparable = (value) => {
  if (value === undefined) return '__undefined__';
  if (value === null) return '__null__';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value).trim();
};

const changedPayloadFields = (current = {}, previous = {}) => {
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(current || {})]);
  keys.delete('__clearFields');
  return [...keys].filter((key) => comparable(current?.[key]) !== comparable(previous?.[key])).sort();
};

// High-impact fields are intentionally conservative. These fields affect asset identity,
// official classification, accounting measurement, useful life, or disposal. They should
// not be mass-approved simply because a source workbook was reviewed before upload.
const FIXED_ASSET_HIGH_IMPACT = new Set([
  'C',
  'D','E','F','G','H','I','J','K','L','M','N','O','P',
  'Y','Z',
  'AF','AG','AH','AI','AJ','AK','AL','AM','AN','AO','AP',
  'AY','AZ','BA','BB',
]);

// Legacy files pre-date Model B. Only descriptive/location/administrative edits are
// considered suitable for grouped approval. Any other Legacy modification remains an
// exception for individual review.
const LEGACY_LOW_RISK = new Set(['B', 'C', 'G', 'AA', 'AB', 'AC', 'AD', 'AE', 'AK']);

const strongIdentity = (record) => {
  const payload = record.payload || {};
  if (record.recordType === 'fixed_asset') {
    return hasValue(payload.Y) || hasValue(payload.Z) || hasValue(payload.AB)
      || hasValue(record.mofAssetNumber) || hasValue(record.entityAssetNumber);
  }
  return hasValue(payload.D) || hasValue(payload.E)
    || hasValue(record.mofAssetNumber) || hasValue(record.entityAssetNumber);
};

const classifyPendingRecord = (record, previousRecord) => {
  if (record.committeeStatus === 'needs_update') {
    return { lane: 'needs_update', reasons: ['السجل محدد بأنه يحتاج تحديثًا قبل الاعتماد'], changedFields: [] };
  }

  if (['approved', 'completed'].includes(record.committeeStatus)) {
    return { lane: 'resolved', reasons: [], changedFields: [] };
  }

  if (record.changeType === 'unchanged') {
    return { lane: 'auto', reasons: ['لا يوجد تغيير عن الدورة السابقة'], changedFields: [] };
  }

  if (record.changeType === 'manual' || record.changeType === 'baseline') {
    return { lane: 'individual', reasons: ['سجل يدوي/أساسي يحتاج قرار مراجع'], changedFields: [] };
  }

  if (!strongIdentity(record)) {
    return { lane: 'individual', reasons: ['هوية الأصل غير كافية للاعتماد الجماعي'], changedFields: [] };
  }

  const payload = record.payload || {};
  if (record.recordType === 'fixed_asset' && ['بيع', 'إتلاف'].includes(String(payload.C || '').trim())) {
    return { lane: 'individual', reasons: ['إجراء بيع/إتلاف يتطلب مراجعة فردية'], changedFields: [] };
  }

  if (record.changeType === 'new') {
    return { lane: 'bulk', reasons: ['سجل جديد بهوية واضحة من ملف تمت مراجعته مسبقًا'], changedFields: [] };
  }

  if (record.changeType !== 'modified') {
    return { lane: 'individual', reasons: ['نوع التغيير يتطلب مراجعة فردية'], changedFields: [] };
  }

  if (!previousRecord) {
    return { lane: 'individual', reasons: ['تعذر العثور على النسخة السابقة للمقارنة'], changedFields: [] };
  }

  const changedFields = changedPayloadFields(record.payload || {}, previousRecord.payload || {});
  if (!changedFields.length) {
    return { lane: 'bulk', reasons: ['لم يظهر اختلاف جوهري بعد مقارنة القيم'], changedFields };
  }

  if (record.recordType === 'fixed_asset') {
    const highImpact = changedFields.filter((field) => FIXED_ASSET_HIGH_IMPACT.has(field));
    if (highImpact.length) {
      return {
        lane: 'individual',
        reasons: [`تغيرت حقول عالية الأثر: ${highImpact.join('، ')}`],
        changedFields,
      };
    }
    return { lane: 'bulk', reasons: ['التغييرات وصفية/تشغيلية منخفضة الأثر'], changedFields };
  }

  const nonLowRisk = changedFields.filter((field) => !LEGACY_LOW_RISK.has(field));
  if (nonLowRisk.length) {
    return {
      lane: 'individual',
      reasons: [`تغيرت حقول Legacy تتطلب تحققًا: ${nonLowRisk.join('، ')}`],
      changedFields,
    };
  }
  return { lane: 'bulk', reasons: ['تغييرات Legacy وصفية/موقعية منخفضة الأثر'], changedFields };
};

const normalizeReviewStatuses = async (cycleId) => {
  const autoApproved = await prisma.accountingTransformationRecord.updateMany({
    where: {
      cycleId,
      changeType: 'unchanged',
      committeeStatus: { in: ['not_reviewed', 'under_review'] },
    },
    data: { committeeStatus: 'approved' },
  });

  const movedToReview = await prisma.accountingTransformationRecord.updateMany({
    where: {
      cycleId,
      changeType: { not: 'unchanged' },
      committeeStatus: 'not_reviewed',
    },
    data: { committeeStatus: 'under_review' },
  });

  return { autoApproved: autoApproved.count, movedToReview: movedToReview.count };
};

const getReviewBreakdown = async (cycleId) => {
  const [notReviewed, underReview, needsUpdate, approved, completed] = await Promise.all([
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'not_reviewed' } }),
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'under_review' } }),
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'needs_update' } }),
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'approved' } }),
    prisma.accountingTransformationRecord.count({ where: { cycleId, committeeStatus: 'completed' } }),
  ]);
  return { notReviewed, underReview, needsUpdate, approved, completed, unresolved: notReviewed + underReview + needsUpdate };
};

const getReviewCenterData = async (cycleId) => {
  const records = await prisma.accountingTransformationRecord.findMany({
    where: { cycleId },
    select: {
      id: true,
      recordNumber: true,
      recordType: true,
      changeType: true,
      committeeStatus: true,
      previousRecordId: true,
      payload: true,
      entityName: true,
      mofAssetNumber: true,
      entityAssetNumber: true,
      assetDescription: true,
    },
    orderBy: [{ changeType: 'asc' }, { recordNumber: 'asc' }],
  });

  const previousIds = [...new Set(records.map((record) => record.previousRecordId).filter(Boolean))];
  const previousRecords = previousIds.length
    ? await prisma.accountingTransformationRecord.findMany({
        where: { id: { in: previousIds } },
        select: { id: true, payload: true },
      })
    : [];
  const previousById = new Map(previousRecords.map((record) => [record.id, record]));

  const buckets = { auto: [], bulk: [], individual: [], needs_update: [], resolved: [] };
  for (const record of records) {
    const classification = classifyPendingRecord(record, previousById.get(record.previousRecordId));
    buckets[classification.lane].push({ record, ...classification });
  }

  const exceptionItems = [...buckets.individual, ...buckets.needs_update].slice(0, 100).map((item) => ({
    id: item.record.id,
    recordNumber: item.record.recordNumber,
    recordType: item.record.recordType,
    changeType: item.record.changeType,
    committeeStatus: item.record.committeeStatus,
    assetDescription: item.record.assetDescription || item.record.entityAssetNumber || item.record.mofAssetNumber || item.record.recordNumber,
    entityAssetNumber: item.record.entityAssetNumber || null,
    changedFields: item.changedFields,
    reasons: item.reasons,
  }));

  return {
    total: records.length,
    autoEligible: buckets.auto.length,
    bulkEligible: buckets.bulk.length,
    individualReview: buckets.individual.length,
    needsUpdate: buckets.needs_update.length,
    resolved: buckets.resolved.length,
    unresolved: buckets.auto.length + buckets.bulk.length + buckets.individual.length + buckets.needs_update.length,
    exceptionItems,
    exceptionItemsTruncated: buckets.individual.length + buckets.needs_update.length > exceptionItems.length,
    bulkEligibleIds: buckets.bulk.map((item) => item.record.id),
  };
};

router.get('/:id/review-center', async (req, res, next) => {
  try {
    if (!canEditCycles(req) && !canApproveCycles(req)) return res.status(403).json({ message: 'لا تملك صلاحية مراجعة دورة التحول المحاسبي' });
    const cycle = await prisma.accountingTransformationCycle.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, isCurrent: true, sourceFileName: true },
    });
    if (!cycle) return res.status(404).json({ message: 'دورة التحديث غير موجودة' });
    const review = await getReviewCenterData(cycle.id);
    res.json({ ...review, cycleStatus: cycle.status, sourceFileName: cycle.sourceFileName || null });
  } catch (error) { next(error); }
});

router.post('/:id/review-center/bulk-approve', async (req, res, next) => {
  try {
    if (!canApproveCycles(req)) return res.status(403).json({ message: 'لا تملك صلاحية اعتماد سجلات الدورة جماعيًا' });
    const cycle = await prisma.accountingTransformationCycle.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, status: true, isCurrent: true, sourceFileName: true },
    });
    if (!cycle) return res.status(404).json({ message: 'دورة التحديث غير موجودة' });
    if (cycle.status !== 'under_review' || cycle.isCurrent) return res.status(409).json({ message: 'الاعتماد الجماعي متاح فقط للدورة المفتوحة تحت المراجعة' });
    if (req.body?.sourcePreReviewed !== true) {
      return res.status(400).json({ message: 'يلزم الإقرار بأن ملف المصدر تمت مراجعته مسبقًا قبل تنفيذ الاعتماد الجماعي' });
    }

    const normalized = await normalizeReviewStatuses(cycle.id);
    const before = await getReviewCenterData(cycle.id);
    const ids = before.bulkEligibleIds;
    let bulkApproved = 0;
    if (ids.length) {
      const updated = await prisma.accountingTransformationRecord.updateMany({
        where: { id: { in: ids }, cycleId: cycle.id, committeeStatus: { in: ['not_reviewed', 'under_review'] } },
        data: { committeeStatus: 'approved', updatedBy: req.authUser?.email || req.authUser?.username || null },
      });
      bulkApproved = updated.count;
    }

    const after = await getReviewCenterData(cycle.id);
    await createAuditLog({
      user: req.authUser,
      action: 'bulk_approve_reviewed_accounting_records',
      module: 'accounting_transformation',
      entity: 'accounting_cycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      description: `اعتماد جماعي للسجلات منخفضة المخاطر من ملف تمت مراجعته مسبقًا (${bulkApproved} سجل)`,
      oldData: { bulkEligible: before.bulkEligible, individualReview: before.individualReview, needsUpdate: before.needsUpdate },
      newData: {
        sourcePreReviewed: true,
        sourceFileName: cycle.sourceFileName || null,
        note: String(req.body?.note || '').trim() || null,
        autoApprovedNow: normalized.autoApproved,
        bulkApproved,
        individualRemaining: after.individualReview,
        needsUpdateRemaining: after.needsUpdate,
      },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: bulkApproved ? `تم اعتماد ${bulkApproved} سجلًا سليمًا جماعيًا` : 'لا توجد سجلات إضافية مؤهلة للاعتماد الجماعي',
      bulkApproved,
      autoApprovedNow: normalized.autoApproved,
      review: after,
    });
  } catch (error) { next(error); }
});

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
  } catch (error) { return next(error); }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    if (!canApproveCycles(req)) return next();
    const cycle = await prisma.accountingTransformationCycle.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, isCurrent: true },
    });
    if (!cycle || cycle.status !== 'under_review' || cycle.isCurrent) return next();

    const normalized = await normalizeReviewStatuses(cycle.id);
    const breakdown = await getReviewBreakdown(cycle.id);
    if (breakdown.unresolved > 0) {
      const reviewCenter = await getReviewCenterData(cycle.id);
      const details = [
        reviewCenter.bulkEligible ? `${reviewCenter.bulkEligible} جاهزة للاعتماد الجماعي` : null,
        reviewCenter.individualReview ? `${reviewCenter.individualReview} تحتاج مراجعة فردية` : null,
        reviewCenter.needsUpdate ? `${reviewCenter.needsUpdate} تحتاج تحديثًا` : null,
        breakdown.notReviewed ? `${breakdown.notReviewed} لم تبدأ مراجعتها` : null,
      ].filter(Boolean).join('، ');
      const autoText = normalized.autoApproved > 0 ? ` تم اعتماد ${normalized.autoApproved} سجل بدون تغيير تلقائيًا.` : '';
      return res.status(409).json({
        message: `لا يمكن اعتماد الدورة بعد: ${details || `${breakdown.unresolved} سجلًا لم تُحسم`}.${autoText} استخدم «مركز المراجعة الذكية» لاعتماد السجلات السليمة جماعيًا ومراجعة الاستثناءات فقط.`,
        code: 'ACCOUNTING_CYCLE_REVIEW_PENDING',
        reviewSummary: { ...breakdown, ...reviewCenter, autoApprovedNow: normalized.autoApproved, movedToReviewNow: normalized.movedToReview },
      });
    }
    return next();
  } catch (error) { return next(error); }
});

export default router;
