import crypto from 'node:crypto';
import { prisma } from '../prisma.js';

const VOLATILE_EXCEL_KEYS = new Set([
  '__sourceFile',
  '__sourceFileHash',
  '__sourceSheet',
  '__sourceRow',
  '__importFingerprint',
  '__platformImportedItemNumber',
  '__sourcePreferredIdentifier',
]);

const ASSET_FIELDS = [
  'itemNumber', 'barcode', 'name', 'category', 'brand', 'model', 'serialNumber', 'status',
  'technicalCondition', 'department', 'building', 'floor', 'room', 'entityName', 'entityCode',
  'assetDescription', 'cardNumber', 'responsibleDepartment', 'region', 'city', 'buildingNumber',
  'coordinates', 'classification1', 'classification2', 'classification3', 'classification4',
  'classification5', 'classification6', 'accountingGroup', 'accountingGroupCode', 'assetCode',
  'remainingLife', 'usefulLife', 'purchaseDate', 'purchaseDateType', 'purchaseValue', 'vatRate',
  'vatAmount', 'purchaseValueBeforeVat', 'purchaseValueIncludingVat', 'serviceDate', 'serviceDateType',
  'acquisitionCost', 'supportingCostDocument', 'archiveDocumentNumber', 'manufacturer',
  'lastInventoryDate', 'lastInventoryDateType', 'unitOfMeasure', 'quantity', 'notes',
];

export const ASSET_FIELD_LABELS = {
  itemNumber: 'رقم الصنف', barcode: 'الباركود', name: 'اسم الأصل', category: 'التصنيف', brand: 'العلامة التجارية',
  model: 'الموديل', serialNumber: 'الرقم التسلسلي', status: 'الحالة', technicalCondition: 'الحالة الفنية',
  department: 'الجهة / الإدارة', building: 'المبنى', floor: 'الدور', room: 'الغرفة', entityName: 'اسم الجهة',
  entityCode: 'رمز الجهة', assetDescription: 'وصف الأصل', cardNumber: 'رقم البطاقة', responsibleDepartment: 'الإدارة المسؤولة',
  region: 'المنطقة', city: 'المدينة', buildingNumber: 'رقم المبنى', coordinates: 'الإحداثيات',
  classification1: 'التصنيف 1', classification2: 'التصنيف 2', classification3: 'التصنيف 3', classification4: 'التصنيف 4',
  classification5: 'التصنيف 5', classification6: 'التصنيف 6', accountingGroup: 'المجموعة المحاسبية',
  accountingGroupCode: 'رمز المجموعة المحاسبية', assetCode: 'رمز الأصل', remainingLife: 'العمر المتبقي', usefulLife: 'العمر الإنتاجي',
  purchaseDate: 'تاريخ الشراء', purchaseDateType: 'نوع تاريخ الشراء', purchaseValue: 'قيمة الشراء', vatRate: 'نسبة الضريبة',
  vatAmount: 'قيمة الضريبة', purchaseValueBeforeVat: 'القيمة قبل الضريبة', purchaseValueIncludingVat: 'القيمة شاملة الضريبة',
  serviceDate: 'تاريخ الدخول في الخدمة', serviceDateType: 'نوع تاريخ الخدمة', acquisitionCost: 'تكلفة الاقتناء',
  supportingCostDocument: 'مستند التكلفة', archiveDocumentNumber: 'رقم مستند الأرشيف', manufacturer: 'المصنع',
  lastInventoryDate: 'آخر تاريخ جرد', lastInventoryDateType: 'نوع تاريخ الجرد', unitOfMeasure: 'وحدة القياس', quantity: 'الكمية', notes: 'الملاحظات',
  excelPayload: 'بيانات Excel الإضافية',
};

export const normalizeAssetCycleText = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

const normalizeKeyPart = (value) => normalizeAssetCycleText(value)
  .toLowerCase()
  .replace(/[ـ]/g, '')
  .replace(/[\u064B-\u065F\u0670]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '-');

const cleanIdentifier = (value) => {
  const text = normalizeAssetCycleText(value);
  if (!text || /^(?:-|--|0|غير متوفر|غير متاح|لا يوجد|n\/?a|null|undefined)$/i.test(text)) return '';
  return text;
};

const excelValue = (payload, ...keys) => {
  const source = payload && typeof payload === 'object' ? payload : {};
  for (const key of keys) {
    const value = cleanIdentifier(source[key]);
    if (value) return value;
  }
  return '';
};

const dateValue = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(raw)) return parsed.toISOString().slice(0, 10);
  return raw;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = canonicalize(value[key]);
    return acc;
  }, {});
};

const cleanExcelPayloadForComparison = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !VOLATILE_EXCEL_KEYS.has(key)));
};

export const assetSnapshotFromAsset = (asset) => ({
  itemNumber: asset.itemNumber || asset.assetNumber || '',
  barcode: asset.barcode || null,
  name: asset.name || '',
  category: asset.category || 'other',
  brand: asset.brand || null,
  model: asset.model || null,
  serialNumber: asset.serialNumber || null,
  status: asset.status || 'available',
  technicalCondition: asset.technicalCondition || null,
  department: asset.department || null,
  building: asset.building || null,
  floor: asset.floor || null,
  room: asset.room || null,
  entityName: asset.entityName || null,
  entityCode: asset.entityCode || null,
  assetDescription: asset.assetDescription || null,
  cardNumber: asset.cardNumber || null,
  responsibleDepartment: asset.responsibleDepartment || null,
  region: asset.region || null,
  city: asset.city || null,
  buildingNumber: asset.buildingNumber || null,
  coordinates: asset.coordinates || null,
  classification1: asset.classification1 || null,
  classification2: asset.classification2 || null,
  classification3: asset.classification3 || null,
  classification4: asset.classification4 || null,
  classification5: asset.classification5 || null,
  classification6: asset.classification6 || null,
  accountingGroup: asset.accountingGroup || null,
  accountingGroupCode: asset.accountingGroupCode || null,
  assetCode: asset.assetCode || null,
  remainingLife: asset.remainingLife ?? null,
  usefulLife: asset.usefulLife ?? null,
  purchaseDate: dateValue(asset.purchaseDate),
  purchaseDateType: asset.purchaseDateType || 'gregorian',
  purchaseValue: asset.purchaseValue ?? null,
  vatRate: asset.vatRate ?? 15,
  vatAmount: asset.vatAmount ?? null,
  purchaseValueBeforeVat: asset.purchaseValueBeforeVat ?? null,
  purchaseValueIncludingVat: asset.purchaseValueIncludingVat ?? null,
  serviceDate: dateValue(asset.serviceDate),
  serviceDateType: asset.serviceDateType || 'gregorian',
  acquisitionCost: asset.acquisitionCost ?? null,
  supportingCostDocument: asset.supportingCostDocument || null,
  archiveDocumentNumber: asset.archiveDocumentNumber || null,
  manufacturer: asset.manufacturer || null,
  lastInventoryDate: dateValue(asset.lastInventoryDate),
  lastInventoryDateType: asset.lastInventoryDateType || 'gregorian',
  unitOfMeasure: asset.unitOfMeasure || null,
  quantity: asset.quantity ?? 1,
  excelPayload: asset.excelPayload || {},
  notes: asset.notes || null,
});

export const normalizeAssetCycleInput = (input = {}) => {
  const snapshot = {};
  for (const field of ASSET_FIELDS) {
    if (['purchaseDate', 'serviceDate', 'lastInventoryDate'].includes(field)) snapshot[field] = dateValue(input[field]);
    else snapshot[field] = input[field] === undefined ? null : input[field];
  }
  snapshot.itemNumber = cleanIdentifier(input.itemNumber || input.assetNumber);
  snapshot.name = normalizeAssetCycleText(input.name);
  snapshot.category = normalizeAssetCycleText(input.category) || 'other';
  snapshot.status = normalizeAssetCycleText(input.status) || 'available';
  snapshot.purchaseDateType = input.purchaseDateType || 'gregorian';
  snapshot.serviceDateType = input.serviceDateType || 'gregorian';
  snapshot.lastInventoryDateType = input.lastInventoryDateType || 'gregorian';
  snapshot.quantity = Number.isFinite(Number(input.quantity)) ? Number(input.quantity) : 1;
  snapshot.excelPayload = input.excelPayload && typeof input.excelPayload === 'object' ? input.excelPayload : {};
  return snapshot;
};

const comparableSnapshot = (snapshot) => {
  const normalized = normalizeAssetCycleInput(snapshot);
  return {
    ...normalized,
    excelPayload: cleanExcelPayloadForComparison(normalized.excelPayload),
  };
};

export const createAssetFingerprint = (snapshot) => crypto
  .createHash('sha256')
  .update(JSON.stringify(canonicalize(comparableSnapshot(snapshot))))
  .digest('hex');

export const createAssetStableKey = (snapshot = {}) => {
  const payload = snapshot.excelPayload || {};
  const mof = excelValue(payload,
    'رقم الأصل الفريد في نظام وزارة المالية (الرقم التعريفي)',
    'Unique Asset Number in MoF system',
    'رقم أصل وزارة المالية'
  );
  const entityUnique = excelValue(payload,
    'رقم الأصل الفريد بالجهة (الرقم المستخدم حاليا للأصل او الرقم تسلسلي)',
    'Unique Asset Number in the entity',
    'رقم الأصل الفريد بالجهة'
  );
  const candidates = [
    ['mof', mof],
    ['serial', snapshot.serialNumber],
    ['barcode', snapshot.barcode],
    ['card', snapshot.cardNumber],
    ['entity', entityUnique],
    ['item', snapshot.itemNumber || snapshot.assetNumber],
  ];
  for (const [kind, value] of candidates) {
    const normalized = normalizeKeyPart(cleanIdentifier(value));
    if (normalized) return { key: `asset:${kind}:${normalized}`, confidence: 'strong' };
  }
  const fallbackSource = [snapshot.name, snapshot.assetDescription, snapshot.department, snapshot.building, snapshot.manufacturer]
    .map(normalizeKeyPart).join('|');
  const hash = crypto.createHash('sha256').update(fallbackSource || JSON.stringify(snapshot)).digest('hex').slice(0, 32);
  return { key: `asset:fallback:${hash}`, confidence: 'fallback' };
};

export const compareAssetSnapshots = (previous = {}, next = {}) => {
  const before = comparableSnapshot(previous);
  const after = comparableSnapshot(next);
  const changed = [];
  for (const field of ASSET_FIELDS) {
    if (JSON.stringify(canonicalize(before[field])) !== JSON.stringify(canonicalize(after[field]))) {
      changed.push(ASSET_FIELD_LABELS[field] || field);
    }
  }
  const beforeExcel = before.excelPayload || {};
  const afterExcel = after.excelPayload || {};
  const excelKeys = new Set([...Object.keys(beforeExcel), ...Object.keys(afterExcel)]);
  for (const key of excelKeys) {
    if (JSON.stringify(canonicalize(beforeExcel[key])) !== JSON.stringify(canonicalize(afterExcel[key]))) {
      changed.push(`Excel: ${key}`);
      if (changed.length >= 40) break;
    }
  }
  return changed;
};

export const assetCycleRecordData = (snapshot, extra = {}) => {
  const normalized = normalizeAssetCycleInput(snapshot);
  const identity = createAssetStableKey(normalized);
  return {
    stableKey: extra.stableKey || identity.key,
    sourceFingerprint: extra.sourceFingerprint || createAssetFingerprint(normalized),
    changeType: extra.changeType || 'manual',
    reviewStatus: extra.reviewStatus || (identity.confidence === 'fallback' ? 'needs_review' : 'auto'),
    previousRecordId: extra.previousRecordId || null,
    assetId: extra.assetId || null,
    itemNumber: cleanIdentifier(normalized.itemNumber) || null,
    assetNumber: cleanIdentifier(normalized.itemNumber) || null,
    barcode: cleanIdentifier(normalized.barcode) || null,
    serialNumber: cleanIdentifier(normalized.serialNumber) || null,
    cardNumber: cleanIdentifier(normalized.cardNumber) || null,
    name: normalizeAssetCycleText(normalized.name) || 'أصل غير مسمى',
    category: normalizeAssetCycleText(normalized.category) || 'other',
    department: normalizeAssetCycleText(normalized.department) || null,
    building: normalizeAssetCycleText(normalized.building) || null,
    changedFields: extra.changedFields || [],
    payload: normalized,
    sourceFileName: extra.sourceFileName || null,
    sourceFileHash: extra.sourceFileHash || null,
    sourceSheet: extra.sourceSheet || null,
    sourceRow: Number.isFinite(Number(extra.sourceRow)) ? Number(extra.sourceRow) : null,
  };
};

export const getCurrentAssetCycle = () => prisma.assetUpdateCycle.findFirst({
  where: { isCurrent: true },
  orderBy: [{ approvedAt: 'desc' }, { updatedAt: 'desc' }],
});

export const ensureAssetBaselineCycle = async () => {
  const cycleCount = await prisma.assetUpdateCycle.count();
  let current = await getCurrentAssetCycle();
  if (!current) {
    const preferred = await prisma.assetUpdateCycle.findFirst({
      where: { status: { in: ['approved', 'archived'] } },
      orderBy: { cycleNumber: 'desc' },
    });
    if (preferred) {
      await prisma.assetUpdateCycle.updateMany({ data: { isCurrent: false } });
      current = await prisma.assetUpdateCycle.update({ where: { id: preferred.id }, data: { isCurrent: true, status: 'approved' } });
    }
  }
  if (!current && cycleCount === 0) {
    current = await prisma.assetUpdateCycle.create({
      data: {
        cycleNumber: 1,
        name: 'الدورة التأسيسية لبيانات الأصول',
        description: 'نسخة تأسيسية أنشأها النظام تلقائيًا لحفظ بيانات الأصول القائمة قبل تفعيل نظام دورات التحديث.',
        status: 'approved', isCurrent: true, approvedAt: new Date(), approvedBy: 'system', createdBy: 'system',
      },
    });
    const assets = await prisma.asset.findMany();
    const rows = assets.map((asset) => {
      const snapshot = assetSnapshotFromAsset(asset);
      return {
        cycleId: current.id,
        ...assetCycleRecordData(snapshot, { changeType: 'baseline', reviewStatus: 'reviewed', assetId: asset.id }),
      };
    });
    for (let index = 0; index < rows.length; index += 750) {
      await prisma.assetCycleRecord.createMany({ data: rows.slice(index, index + 750) });
    }
    await prisma.asset.updateMany({
      data: { isInCurrentCycle: true, cycleState: 'baseline', lastApprovedCycleId: current.id },
    });
  }
  if (!current) {
    const max = await prisma.assetUpdateCycle.aggregate({ _max: { cycleNumber: true } });
    current = await prisma.assetUpdateCycle.create({
      data: {
        cycleNumber: Number(max._max.cycleNumber || 0) + 1,
        name: 'البيانات الحالية للأصول', status: 'approved', isCurrent: true,
        approvedAt: new Date(), approvedBy: 'system', createdBy: 'system',
      },
    });
  }
  return current;
};

export const getAssetCycleComparison = async (cycle) => {
  const targetRecords = await prisma.assetCycleRecord.findMany({
    where: { cycleId: cycle.id },
    select: { id: true, stableKey: true, changeType: true, reviewStatus: true, itemNumber: true, name: true, department: true, assetId: true },
  });
  const baseRecords = cycle.basedOnCycleId
    ? await prisma.assetCycleRecord.findMany({
        where: { cycleId: cycle.basedOnCycleId },
        select: { id: true, stableKey: true, itemNumber: true, name: true, department: true, assetId: true },
      })
    : [];
  const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));
  const removedRecords = baseRecords.filter((item) => item.stableKey && !targetKeys.has(item.stableKey));
  const counts = targetRecords.reduce((acc, item) => {
    acc[item.changeType || 'new'] = (acc[item.changeType || 'new'] || 0) + 1;
    if (item.reviewStatus === 'needs_review') acc.needsReview += 1;
    return acc;
  }, { needsReview: 0 });
  return {
    cycleId: cycle.id,
    basedOnCycleId: cycle.basedOnCycleId || null,
    totalBase: baseRecords.length,
    totalTarget: targetRecords.length,
    new: counts.new || 0,
    modified: counts.modified || 0,
    unchanged: counts.unchanged || 0,
    baseline: counts.baseline || 0,
    manual: counts.manual || 0,
    needsReview: counts.needsReview || 0,
    removed: removedRecords.length,
    removedRecords: removedRecords.slice(0, 250),
  };
};
