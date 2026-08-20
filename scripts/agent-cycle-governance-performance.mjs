import fs from 'node:fs';

const replaceOnce = (file, from, to, label) => {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) {
    if (text.includes(to)) return;
    throw new Error(`Patch target not found: ${label}`);
  }
  fs.writeFileSync(file, text.replace(from, to));
};

// Reuse the application's singleton Prisma client instead of opening an extra pool.
replaceOnce(
  'src/routes/records.routes.js',
  "import express from 'express';\nimport { PrismaClient } from '@prisma/client';\n\nconst router = express.Router();\nconst prisma = new PrismaClient();",
  "import express from 'express';\nimport { prisma } from '../prisma.js';\n\nconst router = express.Router();",
  'records singleton prisma',
);

// Asset cycle list: run independent comparisons concurrently rather than serial N+1 waits.
replaceOnce(
  'src/routes/asset-cycles.routes.js',
  "    const response = [];\n    for (const cycle of cycles) {\n      response.push(serializeCycle(cycle, await getAssetCycleComparison(cycle)));\n    }\n    res.json(response);",
  "    const response = await Promise.all(\n      cycles.map(async (cycle) => serializeCycle(cycle, await getAssetCycleComparison(cycle)))\n    );\n    res.json(response);",
  'asset cycle parallel comparisons',
);

// Asset cycles are partial/merge updates: absence from an incoming departmental file is not removal.
replaceOnce(
  'src/services/assetCycles.service.js',
  "    removed: removedRecords.length,\n    removedRecords: removedRecords.slice(0, 250),",
  "    removed: 0,\n    notSupplied: removedRecords.length,\n    removedRecords: [],",
  'asset partial semantics comparison',
);

const assetHelperAnchor = "const findLiveAssetForRecord = async (tx, record) => {";
const assetHelperEnd = "};\n\nrouter.get('/', async (_req, res, next) => {";
{
  const file = 'src/routes/asset-cycles.routes.js';
  let text = fs.readFileSync(file, 'utf8');
  if (!text.includes('const carryForwardUnchangedAssetRecords = async (cycle) =>')) {
    const start = text.indexOf(assetHelperAnchor);
    const end = text.indexOf(assetHelperEnd, start);
    if (start < 0 || end < 0) throw new Error('Asset helper insertion anchor not found');
    const helper = `};\n\nconst carryForwardUnchangedAssetRecords = async (cycle) => {\n  if (!cycle.basedOnCycleId) return 0;\n  const [baseRecords, targetRecords] = await Promise.all([\n    prisma.assetCycleRecord.findMany({ where: { cycleId: cycle.basedOnCycleId } }),\n    prisma.assetCycleRecord.findMany({ where: { cycleId: cycle.id }, select: { stableKey: true } }),\n  ]);\n  const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));\n  const carryRows = baseRecords\n    .filter((record) => record.stableKey && !targetKeys.has(record.stableKey))\n    .map((record) => {\n      const { id, cycleId: _cycleId, createdAt, updatedAt, ...rest } = record;\n      return {\n        ...rest,\n        cycleId: cycle.id,\n        changeType: 'unchanged',\n        reviewStatus: rest.reviewStatus === 'needs_review' ? 'needs_review' : 'auto',\n        previousRecordId: id,\n        reviewedAt: null,\n        reviewedBy: null,\n      };\n    });\n  for (let index = 0; index < carryRows.length; index += 750) {\n    await prisma.assetCycleRecord.createMany({ data: carryRows.slice(index, index + 750) });\n  }\n  return carryRows.length;\n`;
    text = text.slice(0, end) + helper + text.slice(end + 2);
    fs.writeFileSync(file, text);
  }
}

replaceOnce(
  'src/routes/asset-cycles.routes.js',
  "    const comparison = await getAssetCycleComparison(cycle);\n    const records = await prisma.assetCycleRecord.findMany({ where: { cycleId: cycle.id } });",
  "    const carriedForward = await carryForwardUnchangedAssetRecords(cycle);\n    const comparison = await getAssetCycleComparison(cycle);\n    const records = await prisma.assetCycleRecord.findMany({ where: { cycleId: cycle.id } });",
  'asset carry forward before approval',
);

replaceOnce(
  'src/routes/asset-cycles.routes.js',
  "      newData: { cycle: updated, comparison }, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'],",
  "      newData: { cycle: updated, comparison, carriedForward }, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'],",
  'asset audit carry forward',
);

// Accounting preview is merge-oriented; omitted rows are not removals.
replaceOnce(
  'src/routes/accounting-cycles.routes.js',
  "      removed,\n      newIndexes,",
  "      removed: 0,\n      notSupplied: removed,\n      newIndexes,",
  'accounting partial semantics preview',
);

// Batch accounting inserts to avoid thousands of sequential DB round trips.
replaceOnce(
  'src/routes/accounting-cycles.routes.js',
  "    let created = 0;\n    let skipped = 0;",
  "    const createdRows = [];\n    let created = 0;\n    let skipped = 0;",
  'accounting import row buffer',
);
replaceOnce(
  'src/routes/accounting-cycles.routes.js',
  "      await prisma.accountingTransformationRecord.create({\n        data: {\n          ...data,\n          recordNumber: `ACT-${year}-${String(baseSequence + created).padStart(6, '0')}`,\n          createdBy: userLabel(req),\n        },\n      });",
  "      createdRows.push({\n        ...data,\n        recordNumber: `ACT-${year}-${String(baseSequence + created).padStart(6, '0')}`,\n        createdBy: userLabel(req),\n      });",
  'accounting batch buffer push',
);
replaceOnce(
  'src/routes/accounting-cycles.routes.js',
  "    const updatedCycle = await prisma.accountingTransformationCycle.update({",
  "    if (createdRows.length) {\n      for (let index = 0; index < createdRows.length; index += 750) {\n        await prisma.accountingTransformationRecord.createMany({ data: createdRows.slice(index, index + 750) });\n      }\n    }\n\n    const updatedCycle = await prisma.accountingTransformationCycle.update({",
  'accounting createMany',
);

// Full approved accounting versions are materialized by carrying forward records not supplied in a partial update.
const accountingInsertAnchor = "const itemIsValid = (item) => {\n  const payload = item.payload || {};\n  return hasAccountingValue(payload.B) || hasAccountingValue(payload.E) || hasAccountingValue(payload.G);\n};\n\n";
{
  const file = 'src/routes/accounting-cycles.routes.js';
  let text = fs.readFileSync(file, 'utf8');
  if (!text.includes('const carryForwardUnchangedAccountingRecords = async (cycle) =>')) {
    if (!text.includes(accountingInsertAnchor)) throw new Error('Accounting helper anchor not found');
    const helper = `const carryForwardUnchangedAccountingRecords = async (cycle) => {\n  if (!cycle.basedOnCycleId) return 0;\n  const [baseRecords, targetRecords] = await Promise.all([\n    prisma.accountingTransformationRecord.findMany({ where: { cycleId: cycle.basedOnCycleId } }),\n    prisma.accountingTransformationRecord.findMany({ where: { cycleId: cycle.id }, select: { stableKey: true } }),\n  ]);\n  const targetKeys = new Set(targetRecords.map((item) => item.stableKey).filter(Boolean));\n  const missing = baseRecords.filter((record) => record.stableKey && !targetKeys.has(record.stableKey));\n  if (!missing.length) return 0;\n\n  const baseNumber = await nextAccountingRecordNumber();\n  const baseSequence = Number(baseNumber.split('-').pop()) || 1;\n  const year = new Date().getFullYear();\n  const rows = missing.map((record, index) => {\n    const { id, recordNumber, cycleId: _cycleId, createdAt, updatedAt, ...rest } = record;\n    return {\n      ...rest,\n      cycleId: cycle.id,\n      recordNumber: `ACT-${year}-${String(baseSequence + index).padStart(6, '0')}`,\n      changeType: 'unchanged',\n      previousRecordId: id,\n    };\n  });\n  for (let index = 0; index < rows.length; index += 750) {\n    await prisma.accountingTransformationRecord.createMany({ data: rows.slice(index, index + 750) });\n  }\n  return rows.length;\n};\n\n`;
    text = text.replace(accountingInsertAnchor, accountingInsertAnchor + helper);
    fs.writeFileSync(file, text);
  }
}

replaceOnce(
  'src/routes/accounting-cycles.routes.js',
  "    if (!cycle._count.records) return res.status(409).json({ message: 'لا يمكن اعتماد دورة لا تحتوي على بيانات' });\n\n    const comparison = await getAccountingCycleComparison(cycle);",
  "    if (!cycle._count.records) return res.status(409).json({ message: 'لا يمكن اعتماد دورة لا تحتوي على بيانات' });\n\n    const unresolved = await prisma.accountingTransformationRecord.count({\n      where: { cycleId: cycle.id, committeeStatus: { in: ['not_reviewed', 'under_review', 'needs_update'] } },\n    });\n    if (unresolved) {\n      return res.status(409).json({ message: `لا يمكن اعتماد الدورة: يوجد ${unresolved} سجل لم تُحسم مراجعته أو يحتاج تحديثًا.` });\n    }\n\n    const carriedForward = await carryForwardUnchangedAccountingRecords(cycle);\n    const comparison = await getAccountingCycleComparison(cycle);",
  'accounting approval gate and carry forward',
);
replaceOnce(
  'src/routes/accounting-cycles.routes.js',
  "      newData: { cycle: updated, comparison },",
  "      newData: { cycle: updated, comparison, carriedForward },",
  'accounting audit carry forward',
);

console.log('Governance/performance patch applied successfully.');
