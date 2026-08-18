import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const cleanText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

const parseNullableNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim().replace(/,/g, '');
  if (!text || /^n\/?a$/i.test(text) || text === '-') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};

const stableUsefulLifeKey = (item) => crypto
  .createHash('sha256')
  .update([
    item.level1Ar,
    item.level1En,
    item.level2Ar,
    item.level2En,
    item.level3Ar,
    item.level3En,
  ].map((value) => String(value ?? '').trim().toLowerCase()).join('|'))
  .digest('hex');

const classificationSchema = z.object({
  level1Code: z.string().trim().min(1),
  level1Ar: z.string().trim().min(1),
  level1En: z.string().trim().optional().nullable(),
  level2Code: z.string().trim().min(1),
  level2Ar: z.string().trim().min(1),
  level2En: z.string().trim().optional().nullable(),
  level3Code: z.string().trim().min(1),
  level3Ar: z.string().trim().min(1),
  level3En: z.string().trim().optional().nullable(),
  accountingGroupCode: z.string().trim().min(1),
  accountingGroupAr: z.string().trim().min(1),
  accountingGroupEn: z.string().trim().optional().nullable(),
  accountingAssetCode: z.string().trim().min(1),
  assetCostAccountCode: z.string().trim().optional().nullable(),
  assetCostAccountName: z.string().trim().optional().nullable(),
  clearingAccountCode: z.string().trim().optional().nullable(),
  clearingAccountName: z.string().trim().optional().nullable(),
  lifecycleStatus: z.string().trim().optional().nullable(),
  sourceRow: z.coerce.number().int().positive().optional().nullable(),
});

const usefulLifeSchema = z.object({
  level1Ar: z.string().trim().min(1),
  level1En: z.string().trim().optional().nullable(),
  level2Ar: z.string().trim().min(1),
  level2En: z.string().trim().optional().nullable(),
  level3Ar: z.string().trim().min(1),
  level3En: z.string().trim().optional().nullable(),
  capitalizationLimit: z.union([z.number(), z.string()]).optional().nullable(),
  capitalizationLimitRaw: z.string().trim().optional().nullable(),
  minimumUsefulLife: z.union([z.number(), z.string()]).optional().nullable(),
  maximumUsefulLife: z.union([z.number(), z.string()]).optional().nullable(),
  defaultUsefulLife: z.union([z.number(), z.string()]).optional().nullable(),
  lifecycleStatus: z.string().trim().optional().nullable(),
  sourceRow: z.coerce.number().int().positive().optional().nullable(),
});

const importSchema = z.object({
  versionLabel: z.string().trim().min(2).max(120),
  title: z.string().trim().min(2).max(250).optional().nullable(),
  sourceFileName: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(2000).optional().nullable(),
  classifications: z.array(classificationSchema).min(1).max(10000),
  usefulLives: z.array(usefulLifeSchema).max(10000).default([]),
});

const getCurrentVersion = () => prisma.accountingAssetClassificationVersion.findFirst({
  where: { isCurrent: true },
  orderBy: { importedAt: 'desc' },
});

const pagination = (query) => {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(200, Math.max(10, Number(query.limit || 50)));
  return { page, limit, skip: (page - 1) * limit };
};

router.get('/versions', async (_req, res, next) => {
  try {
    const versions = await prisma.accountingAssetClassificationVersion.findMany({
      orderBy: [{ isCurrent: 'desc' }, { importedAt: 'desc' }],
      take: 50,
    });
    res.json(versions);
  } catch (error) { next(error); }
});

router.get('/stats', async (_req, res, next) => {
  try {
    const version = await getCurrentVersion();
    if (!version) {
      return res.json({
        version: null,
        classificationCount: 0,
        usefulLifeCount: 0,
        level1Count: 0,
        level2Count: 0,
        level3Count: 0,
        accountingGroupCount: 0,
        newAssetCount: 0,
        oldAssetCount: 0,
      });
    }

    const [level1, level2, level3, groups, newAssetCount, oldAssetCount] = await Promise.all([
      prisma.accountingAssetClassification.findMany({ where: { versionId: version.id }, select: { level1Code: true }, distinct: ['level1Code'] }),
      prisma.accountingAssetClassification.findMany({ where: { versionId: version.id }, select: { level1Code: true, level2Code: true }, distinct: ['level1Code', 'level2Code'] }),
      prisma.accountingAssetClassification.findMany({ where: { versionId: version.id }, select: { level1Code: true, level2Code: true, level3Code: true }, distinct: ['level1Code', 'level2Code', 'level3Code'] }),
      prisma.accountingAssetClassification.findMany({ where: { versionId: version.id }, select: { accountingGroupCode: true }, distinct: ['accountingGroupCode'] }),
      prisma.accountingAssetClassification.count({ where: { versionId: version.id, lifecycleStatus: { contains: 'New', mode: 'insensitive' } } }),
      prisma.accountingAssetClassification.count({ where: { versionId: version.id, lifecycleStatus: { contains: 'Old', mode: 'insensitive' } } }),
    ]);

    res.json({
      version,
      classificationCount: version.classificationCount,
      usefulLifeCount: version.usefulLifeCount,
      level1Count: level1.length,
      level2Count: level2.length,
      level3Count: level3.length,
      accountingGroupCount: groups.length,
      newAssetCount,
      oldAssetCount,
    });
  } catch (error) { next(error); }
});

router.get('/options', async (_req, res, next) => {
  try {
    const version = await getCurrentVersion();
    if (!version) return res.json({ levels1: [], accountingGroups: [] });

    const [levels1Rows, groupRows] = await Promise.all([
      prisma.accountingAssetClassification.findMany({
        where: { versionId: version.id },
        select: { level1Code: true, level1Ar: true, level1En: true },
        distinct: ['level1Code', 'level1Ar', 'level1En'],
        orderBy: { level1Code: 'asc' },
      }),
      prisma.accountingAssetClassification.findMany({
        where: { versionId: version.id },
        select: { accountingGroupCode: true, accountingGroupAr: true, accountingGroupEn: true },
        distinct: ['accountingGroupCode', 'accountingGroupAr', 'accountingGroupEn'],
        orderBy: { accountingGroupCode: 'asc' },
      }),
    ]);

    res.json({
      levels1: levels1Rows,
      accountingGroups: groupRows,
    });
  } catch (error) { next(error); }
});

router.get('/classifications', async (req, res, next) => {
  try {
    const version = await getCurrentVersion();
    const { page, limit, skip } = pagination(req.query);
    if (!version) return res.json({ items: [], total: 0, page, limit, pages: 0, version: null });

    const search = String(req.query.search || '').trim();
    const level1Code = String(req.query.level1Code || '').trim();
    const accountingGroupCode = String(req.query.accountingGroupCode || '').trim();
    const lifecycleStatus = String(req.query.lifecycleStatus || '').trim();

    const where = {
      versionId: version.id,
      ...(level1Code && level1Code !== 'all' ? { level1Code } : {}),
      ...(accountingGroupCode && accountingGroupCode !== 'all' ? { accountingGroupCode } : {}),
      ...(lifecycleStatus && lifecycleStatus !== 'all' ? { lifecycleStatus: { contains: lifecycleStatus, mode: 'insensitive' } } : {}),
      ...(search ? { OR: [
        { level1Ar: { contains: search, mode: 'insensitive' } },
        { level1En: { contains: search, mode: 'insensitive' } },
        { level2Ar: { contains: search, mode: 'insensitive' } },
        { level2En: { contains: search, mode: 'insensitive' } },
        { level3Ar: { contains: search, mode: 'insensitive' } },
        { level3En: { contains: search, mode: 'insensitive' } },
        { accountingGroupAr: { contains: search, mode: 'insensitive' } },
        { accountingGroupEn: { contains: search, mode: 'insensitive' } },
        { accountingAssetCode: { contains: search, mode: 'insensitive' } },
        { assetCostAccountCode: { contains: search, mode: 'insensitive' } },
        { assetCostAccountName: { contains: search, mode: 'insensitive' } },
        { clearingAccountCode: { contains: search, mode: 'insensitive' } },
        { clearingAccountName: { contains: search, mode: 'insensitive' } },
      ] } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.accountingAssetClassification.findMany({
        where,
        orderBy: [
          { level1Code: 'asc' },
          { level2Code: 'asc' },
          { level3Code: 'asc' },
          { accountingGroupCode: 'asc' },
        ],
        skip,
        take: limit,
      }),
      prisma.accountingAssetClassification.count({ where }),
    ]);

    res.json({ items, total, page, limit, pages: Math.ceil(total / limit), version });
  } catch (error) { next(error); }
});

router.get('/useful-lives', async (req, res, next) => {
  try {
    const version = await getCurrentVersion();
    const { page, limit, skip } = pagination(req.query);
    if (!version) return res.json({ items: [], total: 0, page, limit, pages: 0, version: null });

    const search = String(req.query.search || '').trim();
    const lifecycleStatus = String(req.query.lifecycleStatus || '').trim();
    const where = {
      versionId: version.id,
      ...(lifecycleStatus && lifecycleStatus !== 'all' ? { lifecycleStatus: { contains: lifecycleStatus, mode: 'insensitive' } } : {}),
      ...(search ? { OR: [
        { level1Ar: { contains: search, mode: 'insensitive' } },
        { level1En: { contains: search, mode: 'insensitive' } },
        { level2Ar: { contains: search, mode: 'insensitive' } },
        { level2En: { contains: search, mode: 'insensitive' } },
        { level3Ar: { contains: search, mode: 'insensitive' } },
        { level3En: { contains: search, mode: 'insensitive' } },
      ] } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.accountingAssetUsefulLife.findMany({
        where,
        orderBy: [{ level1Ar: 'asc' }, { level2Ar: 'asc' }, { level3Ar: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.accountingAssetUsefulLife.count({ where }),
    ]);

    res.json({ items, total, page, limit, pages: Math.ceil(total / limit), version });
  } catch (error) { next(error); }
});

router.post('/import', async (req, res, next) => {
  try {
    const input = importSchema.parse(req.body);
    const version = await prisma.$transaction(async (tx) => {
      await tx.accountingAssetClassificationVersion.updateMany({
        where: { isCurrent: true },
        data: { isCurrent: false },
      });

      const created = await tx.accountingAssetClassificationVersion.create({
        data: {
          versionLabel: input.versionLabel,
          title: input.title || 'دليل تصنيف وترميز الأصول',
          sourceFileName: input.sourceFileName,
          isCurrent: true,
          classificationCount: input.classifications.length,
          usefulLifeCount: input.usefulLives.length,
          importedBy: req.authUser?.email || req.authUser?.username || null,
          importedAt: new Date(),
          notes: input.notes || null,
        },
      });

      await tx.accountingAssetClassification.createMany({
        data: input.classifications.map((item) => ({
          versionId: created.id,
          level1Code: item.level1Code,
          level1Ar: item.level1Ar,
          level1En: cleanText(item.level1En),
          level2Code: item.level2Code,
          level2Ar: item.level2Ar,
          level2En: cleanText(item.level2En),
          level3Code: item.level3Code,
          level3Ar: item.level3Ar,
          level3En: cleanText(item.level3En),
          accountingGroupCode: item.accountingGroupCode,
          accountingGroupAr: item.accountingGroupAr,
          accountingGroupEn: cleanText(item.accountingGroupEn),
          accountingAssetCode: item.accountingAssetCode,
          assetCostAccountCode: cleanText(item.assetCostAccountCode),
          assetCostAccountName: cleanText(item.assetCostAccountName),
          clearingAccountCode: cleanText(item.clearingAccountCode),
          clearingAccountName: cleanText(item.clearingAccountName),
          lifecycleStatus: cleanText(item.lifecycleStatus),
          sourceRow: item.sourceRow || null,
        })),
      });

      if (input.usefulLives.length) {
        await tx.accountingAssetUsefulLife.createMany({
          data: input.usefulLives.map((item) => ({
            versionId: created.id,
            stableKey: stableUsefulLifeKey(item),
            level1Ar: item.level1Ar,
            level1En: cleanText(item.level1En),
            level2Ar: item.level2Ar,
            level2En: cleanText(item.level2En),
            level3Ar: item.level3Ar,
            level3En: cleanText(item.level3En),
            capitalizationLimit: parseNullableNumber(item.capitalizationLimit),
            capitalizationLimitRaw: cleanText(item.capitalizationLimitRaw ?? item.capitalizationLimit),
            minimumUsefulLife: parseNullableNumber(item.minimumUsefulLife),
            maximumUsefulLife: parseNullableNumber(item.maximumUsefulLife),
            defaultUsefulLife: parseNullableNumber(item.defaultUsefulLife),
            lifecycleStatus: cleanText(item.lifecycleStatus),
            sourceRow: item.sourceRow || null,
          })),
          skipDuplicates: true,
        });
      }

      return created;
    }, { timeout: 30000 });

    res.status(201).json({
      version,
      imported: {
        classifications: input.classifications.length,
        usefulLives: input.usefulLives.length,
      },
    });
  } catch (error) { next(error); }
});

export default router;
