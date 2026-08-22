import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import {
  ACCOUNTING_CORE_COLUMNS,
  calculateAccountingProgress,
  inferAccountingOwnershipMode,
} from '../config/accountingTransformation.js';
import { calculateModelBDerivedPayload, validateModelBPayload } from '../config/fixedAssetModelB.js';

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

const UNAVAILABLE_IDENTITY_VALUES = new Set([
  'غير-متوفر',
  'غير-متاح',
  'لا-يوجد',
  'بدون',
  'not-available',
  'not-applicable',
  'n-a',
  'na',
  'none',
  'null',
]);

const normalizeIdentityPart = (value) => {
  const normalized = normalizeKeyPart(value);
  return normalized && !UNAVAILABLE_IDENTITY_VALUES.has(normalized) ? normalized : '';
};

export const accountingCoreFromPayload = (recordType, payload = {}) => {
  const map = ACCOUNTING_CORE_COLUMNS[recordType] || ACCOUNTING_CORE_COLUMNS.land;
  return {
    entityName: normalizeAccountingText(payload[map.entityName]) || null,
    entityCode: normalizeAccountingText(payload[map.entityCode]) || null,
    mofAssetNumber: normalizeAccountingText(payload[map.mofAssetNumber]) || null,
    entityAssetNumber: normalizeAccountingText(payload[map.entityAssetNumber]) || null,
    linkedAsset: normalizeAccountingText(payload[map.linkedAsset]) || null,
    assetDescription: normalizeAccountingText(payload[map.assetDescription]) || null,
    accountingGroup: normalizeAccountingText(payload[map.accountingGroup]) || null,
    accountingGroupCode: normalizeAccountingText(payload[map.accountingGroupCode]) || null,
    accountingAssetCode: normalizeAccountingText(payload[map.accountingAssetCode]) || null,
    region: normalizeAccountingText(payload[map.region]) || null,
    city: normalizeAccountingText(payload[map.city]) || null,
  };
};

const fingerprintPayload = (recordType, payload = {}) =>
  recordType === 'fixed_asset' ? calculateModelBDerivedPayload(payload) : payload;

export const createAccountingFingerprint = (recordType, payload = {}) =>
  crypto
    .createHash('sha256')
    .update(`${recordType}:${JSON.stringify(fingerprintPayload(recordType, payload))}`)
    .digest('hex');

const looksLikeStrongEntityAssetIdentity = (value) => {
  const normalized = normalizeIdentityPart(value);
  if (!normalized) return false;
  const compact = normalized.replace(/-/g, '');
  const digits = (compact.match(/\d/g) || []).length;
  const latin = (compact.match(/[a-z]/gi) || []).length;
  if (digits >= 6) return true;
  return compact.length >= 10 && digits >= 4 && latin >= 2;
};

export const canonicalizeAccountingStableKey = (stableKey) => {
  const key = String(stableKey || '').trim();
  if (!key) return '';

  // Legacy building keys intentionally include physical discriminators because
  // labels such as A4 or villa names are often reused. When the entity number is
  // a strong identifier, remove those legacy-only discriminators so the same
  // asset can match a later Model B row even if the sheet/column layout changed.
  const buildingEntity = key.match(/^building:entity:([^:]+):([^:]+):(.+)$/);
if (buildingEntity) {
  if (looksLikeStrongEntityAssetIdentity(buildingEntity[2])) {
    return `asset:entity:${buildingEntity[1]}:${buildingEntity[2]}`;
  }
  return key;
}

  const strong = key.match(/^(?:land|building|fixed_asset|asset):(mof|entity):(.+)$/);
  if (strong) return `asset:${strong[1]}:${strong[2]}`;
  return key;
};

export const createAccountingStableKey = (recordType, payload = {}, coreInput = null) => {
  const core = coreInput || accountingCoreFromPayload(recordType, payload);
  const entityCode = normalizeKeyPart(core.entityCode);
  const entityAsset = normalizeIdentityPart(core.entityAssetNumber);
  const mof = normalizeIdentityPart(core.mofAssetNumber);

  if (recordType === 'fixed_asset') {
    if (mof) return `asset:mof:${mof}`;
    if (entityAsset) return `asset:entity:${entityCode || 'na'}:${entityAsset}`;
    const tag = normalizeIdentityPart(payload.AB);
    if (tag) return `asset:tag:${tag}`;
    const fallback = [
      core.entityName,
      core.assetDescription,
      payload.E,
      payload.H,
      payload.K,
      core.accountingAssetCode,
      core.linkedAsset,
      core.region,
      core.city,
      payload.AC,
      payload.AD,
      payload.AE,
    ].map(normalizeKeyPart).join('|');
    return `asset:fallback:${crypto.createHash('sha256').update(fallback || JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
  }

  const type = recordType === 'building' ? 'building' : 'land';
  const accounting = normalizeKeyPart(core.accountingAssetCode);
  const linked = normalizeKeyPart(core.linkedAsset);
  if (mof) return `${type}:mof:${mof}`;
  if (entityAsset) {
    if (type === 'building') {
      // Legacy building files sometimes reuse human-readable building numbers (A4,
      // villa model names, etc.). Combine them with physical discriminators instead
      // of treating the repeated label alone as a universally unique identifier.
      const discriminator = [payload.BC, payload.G, payload.AP, payload.AN]
        .map(normalizeKeyPart)
        .filter(Boolean)
        .join(':');
      return `building:entity:${entityCode || 'na'}:${entityAsset}:${linked || 'na'}:${discriminator || 'na'}`;
    }
    return `${type}:entity:${entityCode || 'na'}:${entityAsset}`;
  }

  // Placeholder values such as "غير متوفر" are not identities. For Legacy rows
  // without a strong asset number, use physical/location attributes as part of
  // the fallback so repeated buildings in the same complex remain distinguishable.
  const fallback = [
    type,
    entityCode,
    core.entityName,
    core.assetDescription,
    linked,
    accounting,
    core.accountingGroupCode,
    core.region,
    core.city,
    payload.AN,
    payload.AO,
    payload.AP,
    payload.BC,
    payload.BD,
    payload.CI,
  ].map(normalizeKeyPart).join('|');
  return `${type}:fallback:${crypto.createHash('sha256').update(fallback || JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
};

export const buildAccountingSnapshotData = (input, authUser, extra = {}) => {
  const sourcePayload = input.payload || {};
  const modelBValidation = input.recordType === 'fixed_asset' ? validateModelBPayload(sourcePayload) : null;
  const payload = modelBValidation?.payload || sourcePayload;
  const ownershipMode = input.ownershipMode || inferAccountingOwnershipMode(input.recordType, payload);
  const progress = calculateAccountingProgress(input.recordType, payload, ownershipMode);
  const core = accountingCoreFromPayload(input.recordType, payload);
  const sourceFingerprint = extra.sourceFingerprint || createAccountingFingerprint(input.recordType, payload);
  const stableKey = extra.stableKey || createAccountingStableKey(input.recordType, payload, core);
  const requestedStatus = input.committeeStatus || 'not_reviewed';
  const committeeStatus = modelBValidation && !modelBValidation.complete && requestedStatus === 'not_reviewed'
    ? 'needs_update'
    : requestedStatus;

  return {
    recordType: input.recordType,
    ownershipMode,
    committeeStatus,
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
    const aggregate = await prisma.accountingTransformationCycle.aggregate({ _max: { cycleNumber: true } });
    current = await prisma.accountingTransformationCycle.create({
      data: {
        cycleNumber: Number(aggregate._max.cycleNumber || 0) + 1,
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
      id: true, recordType: true, payload: true, entityName: true, entityCode: true,
      mofAssetNumber: true, entityAssetNumber: true, linkedAsset: true, assetDescription: true,
      accountingGroup: true, accountingGroupCode: true, accountingAssetCode: true, region: true,
      city: true, sourceFingerprint: true, stableKey: true, changeType: true,
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
  const [targetRecords, baseRecords] = await Promise.all([
    prisma.accountingTransformationRecord.findMany({
      where: { cycleId: cycle.id },
      select: {
        id: true, stableKey: true, changeType: true, recordNumber: true, recordType: true,
        entityName: true, entityAssetNumber: true, assetDescription: true,
      },
    }),
    cycle.basedOnCycleId
      ? prisma.accountingTransformationRecord.findMany({
          where: { cycleId: cycle.basedOnCycleId },
          select: {
            id: true, stableKey: true, recordNumber: true, recordType: true,
            entityName: true, entityAssetNumber: true, assetDescription: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const targetKeys = new Set(targetRecords.map((item) => canonicalizeAccountingStableKey(item.stableKey)).filter(Boolean));
  const removedRecords = baseRecords.filter((item) => {
    const key = canonicalizeAccountingStableKey(item.stableKey);
    return key && !targetKeys.has(key);
  });
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