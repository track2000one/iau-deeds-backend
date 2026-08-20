import { Router } from 'express';
import { prisma } from '../prisma.js';

const router = Router();
const BATCH_SIZE = 2000;

const text = (value) => String(value ?? '').trim();
const valueOr = (value, fallback = '') => text(value) || fallback;
const average = (total, count) => Math.round(Number(total || 0) / Math.max(1, Number(count || 0)));

const baseWhere = (req) => {
  const search = text(req.query.search);
  const recordType = text(req.query.recordType);
  const committeeStatus = text(req.query.committeeStatus);
  const readinessStatus = text(req.query.readinessStatus);
  const cycleId = text(req.query.cycleId);
  const cycleWhere = cycleId ? { cycleId } : { cycle: { isCurrent: true } };
  const filters = [
    ...(recordType && recordType !== 'all' ? [{ recordType }] : []),
    ...(committeeStatus && committeeStatus !== 'all' ? [{ committeeStatus }] : []),
    ...(readinessStatus && readinessStatus !== 'all' ? [{ readinessStatus }] : []),
    ...(search ? [{ OR: [
      { recordNumber: { contains: search, mode: 'insensitive' } },
      { entityName: { contains: search, mode: 'insensitive' } },
      { entityAssetNumber: { contains: search, mode: 'insensitive' } },
      { mofAssetNumber: { contains: search, mode: 'insensitive' } },
      { linkedAsset: { contains: search, mode: 'insensitive' } },
      { assetDescription: { contains: search, mode: 'insensitive' } },
      { accountingAssetCode: { contains: search, mode: 'insensitive' } },
      { city: { contains: search, mode: 'insensitive' } },
      { region: { contains: search, mode: 'insensitive' } },
    ] }] : []),
  ];
  return { ...cycleWhere, ...(filters.length ? { AND: filters } : {}) };
};

const legacyClassification = (payload = {}) => ({
  level1Code: valueOr(payload.J),
  level1Label: valueOr(payload.H),
  level2Code: valueOr(payload.M),
  level2Label: valueOr(payload.K),
  groupCode: valueOr(payload.S),
  groupLabel: valueOr(payload.Q),
});

const fixedClassification = (record) => {
  const payload = record.payload || {};
  const assetCode = valueOr(record.accountingAssetCode || payload.P);
  return {
    level1Code: valueOr(payload.D, assetCode.slice(0, 2)),
    level1Label: valueOr(payload.E),
    level2Code: valueOr(payload.G, assetCode.slice(2, 4)),
    level2Label: valueOr(payload.H),
    groupCode: valueOr(payload.M || record.accountingGroupCode, assetCode.slice(-2)),
    groupLabel: valueOr(payload.N || record.accountingGroup),
  };
};

const hierarchyIdentity = (record) => {
  const isFixed = record.recordType === 'fixed_asset';
  const c = isFixed ? fixedClassification(record) : legacyClassification(record.payload || {});
  const level1Code = c.level1Code || 'unclassified';
  const level2Code = c.level2Code || 'unclassified';
  const groupCode = c.groupCode || 'unclassified';

  if (isFixed) {
    return {
      topKey: `fixed|${level1Code}`,
      topLabel: c.level1Label || 'غير مصنف — يحتاج مراجعة',
      topCode: c.level1Code || null,
      leafKey: `fixed|${level1Code}|${level2Code}|${groupCode}`,
      leafLabel: c.level2Label || 'بدون تصنيف فرعي',
      leafCode: c.level2Code || null,
      accountingGroupLabel: c.groupLabel || 'بدون مجموعة محاسبية',
      accountingGroupCode: c.groupCode || null,
      recordType: 'fixed_asset',
      legacy: false,
    };
  }

  const isLand = record.recordType === 'land';
  return {
    topKey: `legacy|${record.recordType}`,
    topLabel: isLand ? 'الأراضي — Legacy' : 'المباني — Legacy',
    topCode: null,
    leafKey: `legacy|${record.recordType}|${level1Code}|${level2Code}|${groupCode}`,
    leafLabel: c.level2Label || c.level1Label || (isLand ? 'سجلات الأراضي' : 'سجلات المباني'),
    leafCode: c.level2Code || c.level1Code || null,
    accountingGroupLabel: c.groupLabel || record.accountingGroup || 'بدون مجموعة محاسبية',
    accountingGroupCode: c.groupCode || record.accountingGroupCode || null,
    recordType: record.recordType,
    legacy: true,
  };
};

const createBucket = (identity) => ({
  key: identity.topKey,
  label: identity.topLabel,
  code: identity.topCode,
  recordType: identity.recordType,
  legacy: identity.legacy,
  count: 0,
  overallTotal: 0,
  censusTotal: 0,
  inventoryTotal: 0,
  valuationTotal: 0,
  children: new Map(),
});

const createLeaf = (identity) => ({
  key: identity.leafKey,
  label: identity.leafLabel,
  code: identity.leafCode,
  accountingGroupLabel: identity.accountingGroupLabel,
  accountingGroupCode: identity.accountingGroupCode,
  recordType: identity.recordType,
  count: 0,
  overallTotal: 0,
  censusTotal: 0,
  inventoryTotal: 0,
  valuationTotal: 0,
});

const addMetrics = (target, record) => {
  target.count += 1;
  target.overallTotal += Number(record.overallProgress || 0);
  target.censusTotal += Number(record.censusProgress || 0);
  target.inventoryTotal += Number(record.inventoryProgress || 0);
  target.valuationTotal += Number(record.valuationProgress || 0);
};

const summarizeMetrics = (bucket) => ({
  count: bucket.count,
  averageOverall: average(bucket.overallTotal, bucket.count),
  averageCensus: average(bucket.censusTotal, bucket.count),
  averageInventory: average(bucket.inventoryTotal, bucket.count),
  averageValuation: average(bucket.valuationTotal, bucket.count),
});

router.get('/', async (req, res, next) => {
  try {
    const where = baseWhere(req);
    const topMap = new Map();
    let cursor = null;

    for (;;) {
      const rows = await prisma.accountingTransformationRecord.findMany({
        where,
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          recordType: true,
          payload: true,
          accountingGroup: true,
          accountingGroupCode: true,
          accountingAssetCode: true,
          overallProgress: true,
          censusProgress: true,
          inventoryProgress: true,
          valuationProgress: true,
        },
      });
      if (!rows.length) break;

      for (const record of rows) {
        const identity = hierarchyIdentity(record);
        const top = topMap.get(identity.topKey) || createBucket(identity);
        addMetrics(top, record);
        const leaf = top.children.get(identity.leafKey) || createLeaf(identity);
        addMetrics(leaf, record);
        top.children.set(identity.leafKey, leaf);
        topMap.set(identity.topKey, top);
      }

      cursor = rows[rows.length - 1].id;
      if (rows.length < BATCH_SIZE) break;
    }

    const result = Array.from(topMap.values()).map((top) => ({
      key: top.key,
      label: top.label,
      code: top.code,
      recordType: top.recordType,
      legacy: top.legacy,
      ...summarizeMetrics(top),
      children: Array.from(top.children.values()).map((leaf) => ({
        key: leaf.key,
        label: leaf.label,
        code: leaf.code,
        accountingGroupLabel: leaf.accountingGroupLabel,
        accountingGroupCode: leaf.accountingGroupCode,
        recordType: leaf.recordType,
        ...summarizeMetrics(leaf),
      })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ar')),
    })).sort((a, b) => {
      if (a.legacy !== b.legacy) return a.legacy ? 1 : -1;
      return b.count - a.count || a.label.localeCompare(b.label, 'ar');
    });

    res.json(result);
  } catch (error) { next(error); }
});

const leafWhere = (key) => {
  const parts = text(key).split('|');
  if (parts[0] === 'fixed' && parts.length >= 4) {
    const [, level1, level2, group] = parts;
    const clauses = [{ recordType: 'fixed_asset' }];
    if (level1 !== 'unclassified' || level2 !== 'unclassified') {
      const prefix = `${level1 === 'unclassified' ? '' : level1}${level2 === 'unclassified' ? '' : level2}`;
      if (prefix) clauses.push({ accountingAssetCode: { startsWith: prefix, mode: 'insensitive' } });
    }
    if (group !== 'unclassified') clauses.push({ accountingGroupCode: { equals: group, mode: 'insensitive' } });
    return { AND: clauses };
  }

  if (parts[0] === 'legacy' && parts.length >= 5) {
    const [, type, level1, level2, group] = parts;
    const clauses = [{ recordType: type }];
    const prefix = `${level1 === 'unclassified' ? '' : level1}${level2 === 'unclassified' ? '' : level2}`;
    if (prefix) clauses.push({ accountingAssetCode: { startsWith: prefix, mode: 'insensitive' } });
    if (group !== 'unclassified') clauses.push({ accountingGroupCode: { equals: group, mode: 'insensitive' } });
    return { AND: clauses };
  }
  return null;
};

const matchesLeafExactly = (record, key) => hierarchyIdentity(record).leafKey === key;

router.get('/records', async (req, res, next) => {
  try {
    const key = text(req.query.key);
    if (!key) return res.status(400).json({ message: 'مفتاح المجموعة مطلوب.' });
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(72, Math.max(12, Number(req.query.limit) || 36));
    const structuredWhere = leafWhere(key);
    const where = { ...baseWhere(req), ...(structuredWhere || {}) };

    if (key.includes('unclassified')) {
      const candidates = await prisma.accountingTransformationRecord.findMany({
        where: baseWhere(req),
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      });
      const exact = candidates.filter((record) => matchesLeafExactly(record, key));
      const start = (page - 1) * limit;
      return res.json({
        items: exact.slice(start, start + limit),
        page,
        limit,
        total: exact.length,
        totalPages: Math.max(1, Math.ceil(exact.length / limit)),
      });
    }

    const [total, items] = await Promise.all([
      prisma.accountingTransformationRecord.count({ where }),
      prisma.accountingTransformationRecord.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    res.json({ items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (error) { next(error); }
});

export default router;
