import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import {
  ACCOUNTING_CORE_COLUMNS,
  calculateAccountingProgress,
  inferAccountingOwnershipMode,
} from '../config/accountingTransformation.js';

export const normalizeAccountingText = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

const normalizeKeyPart = (value) =>
  normalizeAccountingText(value)
    .toLowerCase()
    .replace(/[ـ]/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-');

export const accountingCoreFromPayload = (recordType, payload = {}) => {
  const map = ACCOUNTING_CORE_COLUMNS[recordType] || ACCOUNTING_CORE_COLUMNS.land;
  return {
    entityName: normalizeAccountingText(payload.B) || null,
    entityCode: normalizeAccountingText(payload.C) || null,
    mofAssetNumber: normalizeAccountingText(payload.D) || null,
    entityAssetNumber: normalizeAccountingText(payload.E) || null,
    linkedAsset: normalizeAccountingText(payload.F) || null,
    assetDescription: normalizeAccountingText(payload.G) || null,
    accountingGroup: normalizeAccountingText(payload.Q) || null,
    accountingGroupCode: normalizeAccountingText(payload.S) || null,
    accountingAssetCode: normalizeAccountingText(payload.T) || null,
    region: normalizeAccountingText(payload[map.region]) || null,
    city: normalizeAccountingText(payload[map.city]) || null,
  };
};

export const createAccountingFingerprint = (recordType, payload = {}) =>
  crypto
    .createHash('sha256')
    .update(`${recordType}:${JSON.stringify(payload)}`)
    .digest('hex');

export const createAccountingStableKey = (recordType, payload = {}, coreInput = null) => {
  const core = coreInput || accountingCoreFromPayload(recordType, payload);
  const type = recordType === 'building' ? 'building' : 'land';
  const entityCode = normalizeKeyPart(core.entityCode);
  const entityAsset = normalizeKeyPart(core.entityAssetNumber);
  const mof = normalizeKeyPart(core.mofAssetNumber);
  const accounting = normalizeKeyPart(core.accountingAssetCode);
  const linked = normalizeKeyPart(core.linkedAsset);

  if (mof) return `${type}:mof:${mof}`;
  if (entityAsset) return `${type}:entity:${entityCode || 'na'}:${entityAsset}`;
  if (accounting) return `${type}:accounting:${accounting}`;
  if (linked) return `${type}:linked:${linked}`;

  const fallback = [
    type,
    core.entityName,
    core.assetDescription,
    core.accountingGroupCode,
    core.region,
    core.city,
  ].map(normalizeKeyPart).join('|');

  return `${type}:fallback:${crypto.createHash('sha256').update(fallback).digest('hex').slice(0, 32)}`;
};

export const buildAccountingSnapshotData = (input, authUser, extra = {}) => {
  const payload = input.payload || {};
  const ownershipMode = input.ownershipMode || inferAccountingOwnershipMode(input.recordType, payload);
  const progress = calculateAccountingProgress(input.recordType, payload, ownershipMode);
  const core = accountingCoreFromPayload(input.recordType, payload);
  const sourceFingerprint = extra.sourceFingerprint || createAccountingFingerprint(input.recordType, payload);
  const stableKey = extra.stableKey || createAccountingStableKey(input.recordType, payload, core);

  return {
    recordType: input.recordType,
    ownershipMode,
    committeeStatus: input.committeeStatus || 'not_reviewed',
    ...core,
    ...progress,
    payload,
    attachments: input.attachments || [],
    notes: input.notes || null,
    updatedBy: authUser?.email || authUser?.username || null,
    sourceFingerprint,
    stableKey,
    ...extra,
  };
};

export const getCurrentAccountingCycle = () =>
  prisma.accountingTransformationCycle.findFirst({
    where: { isCurrent: true },
    orderBy: [{ approvedAt: 'desc' }, { updatedAt: 'desc' }],
  });

export const ensureAccountingTransformationBaseline = async () => {
  const cycleCount = await prisma.accountingTransformationCycle.count();
  let current = await getCurrentAccountingCycle();

  if (!current) {
    const preferred = await prisma.accountingTransformationCycle.findFirst({
      where: { status: { in: ['approved', 'archived'] } },
      orderBy: [{ cycleNumber: 'desc' }],
    });

    if (preferred) {
      await prisma.accountingTransformationCycle.updateMany({ data: { isCurrent: false } });
      current = await prisma.accountingTransformationCycle.update({
        where: { id: preferred.id },
        data: { isCurrent: true, status: 'approved' },
      });
    }
  }

  if (!current && cycleCount === 0) {
    current = await prisma.accountingTransformationCycle.create({
      data: {
        cycleNumber: 1,
        name: 'البيانات الأساسية قبل نظام الدورات',
        description: 'دورة تأسيسية أنشأها النظام تلقائيًا لحفظ البيانات القائمة قبل تفعيل إدارة الإصدارات.',
        status: 'approved',
        isCurrent: true,
        approvedAt: new Date(),
        approvedBy: 'system',
        createdBy: 'system',
      },
    });
  }

  if (!current) {
    current = await prisma.accountingTransformationCycle.create({
      data: {
        cycleNumber: (await prisma.accountingTransformationCycle.aggregate({ _max: { cycleNumber: true } }))._max.cycleNumber + 1,
        name: 'البيانات الحالية',
        status: 'approved',
        isCurrent: true,
        approvedAt: new Date(),
        approvedBy: 'system',
        createdBy: 'system',
      },
    });
  }

  const legacyRecords = await prisma.accountingTransformationRecord.findMany({
    where: { cycleId: null },
    select: {
      id: true,
      recordType: true,
      payload: true,
      entityName: true,
      entityCode: true,
      mofAssetNumber: true,
      entityAssetNumber: true,
      linkedAsset: true,
      assetDescription: true,
      accountingGroup: true,
      accountingGroupCode: true,
      accountingAssetCode: true,
      region: true,
      city: true,
      sourceFingerprint: true,
      stableKey: true,
    },
  });

  for (const record of legacyRecords) {
    const payload = record.payload || {};
    const stableKey = record.stableKey || createAccountingStableKey(record.recordType, payload, record);
    const sourceFingerprint = record.sourceFingerprint || createAccountingFingerprint(record.recordType, payload);
    await prisma.accountingTransformationRecord.update({
      where: { id: record.id },
      data: {
        cycleId: current.id,
        stableKey,
        sourceFingerprint,
        changeType: record.changeType || 'baseline',
      },
    });
  }

  return current;
};

export const nextAccountingRecordNumber = async (offset = 0) => {
  const year = new Date().getFullYear();
  const start = new Date(`${year}-01-01T00:00:00.000Z`);
  const end = new Date(`${year + 1}-01-01T00:00:00.000Z`);
  const count = await prisma.accountingTransformationRecord.count({
    where: { createdAt: { gte: start, lt: end } },
  });
  return `ACT-${year}-${String(count + offset + 1).padStart(6, '0')}`;
};

export const getAccountingCycleComparison = async (cycle) => {
  const targetRecords = await prisma.accountingTransformationRecord.findMany({
    where: { cycleId: cycle.id },
    select: {
      id: true,
      stableKey: true,
      changeType: true,
      recordNumber: true,
      recordType: true,
      entityName: true,
      entityAssetNumber: true,
      assetDescription: true,
    },
  });

  const baseRecords = cycle.basedOnCycleId
    ? await prisma.accountingTransformationRecord.findMany({
        where: { cycleId: cycle.basedOnCycleId },
        select: {
          id: true,
          stableKey: true,
          recordNumber: true,
          recordType: true,
          entityName: true,
          entityAssetNumber: true,
          assetDescription: true,
        },
      })
    : [];

  const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));
  const removedRecords = baseRecords.filter((item) => item.stableKey && !targetKeys.has(item.stableKey));
  const countByType = targetRecords.reduce((acc, item) => {
    const key = item.changeType || 'new';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    cycleId: cycle.id,
    basedOnCycleId: cycle.basedOnCycleId || null,
    totalBase: baseRecords.length,
    totalTarget: targetRecords.length,
    new: countByType.new || 0,
    modified: countByType.modified || 0,
    unchanged: countByType.unchanged || 0,
    baseline: countByType.baseline || 0,
    manual: countByType.manual || 0,
    removed: removedRecords.length,
    removedRecords: removedRecords.slice(0, 200),
  };
};
