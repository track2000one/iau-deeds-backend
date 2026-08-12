const fs = require('fs');
const path = 'src/routes/accounting-transformation.routes.js';
let s = fs.readFileSync(path, 'utf8');

if (!s.includes('const accountingGroupKey =')) {
  const anchor = "const queryWhere = (req) => {";
  const insert = `const accountingGroupKey = (item) => {\n  const code = normalizedText(item.accountingGroupCode);\n  const label = normalizedText(item.accountingGroup);\n  if (code || label) return { key: \`group:\${code || label}\`, label: label || code, code: code || null };\n  return item.recordType === 'land'\n    ? { key: 'type:land', label: 'الأراضي', code: null }\n    : { key: 'type:building', label: 'المباني', code: null };\n};\n\n`;
  if (!s.includes(anchor)) throw new Error('queryWhere anchor missing');
  s = s.replace(anchor, insert + anchor);
}

if (!s.includes("const groupKey = normalizedText(req.query.group);")) {
  const from = "  const readinessStatus = normalizedText(req.query.readinessStatus);\n\n  return {";
  const to = "  const readinessStatus = normalizedText(req.query.readinessStatus);\n  const groupKey = normalizedText(req.query.group);\n\n  const groupWhere = groupKey && groupKey !== 'all'\n    ? groupKey === 'type:land'\n      ? { recordType: 'land' }\n      : groupKey === 'type:building'\n        ? { recordType: 'building' }\n        : groupKey.startsWith('group:')\n          ? { OR: [\n              { accountingGroupCode: { equals: groupKey.slice(6), mode: 'insensitive' } },\n              { accountingGroup: { equals: groupKey.slice(6), mode: 'insensitive' } },\n            ] }\n          : {}\n    : {};\n\n  return {\n    ...groupWhere,";
  if (!s.includes(from)) throw new Error('group where anchor missing');
  s = s.replace(from, to);
}

if (!s.includes("router.get('/groups'")) {
  const anchor = "router.get('/stats', async (_req, res, next) => {";
  const block = `router.get('/groups', async (req, res, next) => {\n  try {\n    const where = queryWhere(req);\n    const records = await prisma.accountingTransformationRecord.findMany({\n      where,\n      select: {\n        recordType: true,\n        accountingGroup: true,\n        accountingGroupCode: true,\n        overallProgress: true,\n        censusProgress: true,\n        inventoryProgress: true,\n        valuationProgress: true,\n      },\n    });\n    const map = new Map();\n    for (const item of records) {\n      const group = accountingGroupKey(item);\n      const current = map.get(group.key) || {\n        key: group.key, label: group.label, code: group.code, count: 0,\n        overallTotal: 0, censusTotal: 0, inventoryTotal: 0, valuationTotal: 0,\n      };\n      current.count += 1;\n      current.overallTotal += Number(item.overallProgress || 0);\n      current.censusTotal += Number(item.censusProgress || 0);\n      current.inventoryTotal += Number(item.inventoryProgress || 0);\n      current.valuationTotal += Number(item.valuationProgress || 0);\n      map.set(group.key, current);\n    }\n    const groups = Array.from(map.values()).map((g) => ({\n      key: g.key, label: g.label, code: g.code, count: g.count,\n      averageOverall: Math.round(g.overallTotal / Math.max(1, g.count)),\n      averageCensus: Math.round(g.censusTotal / Math.max(1, g.count)),\n      averageInventory: Math.round(g.inventoryTotal / Math.max(1, g.count)),\n      averageValuation: Math.round(g.valuationTotal / Math.max(1, g.count)),\n    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ar'));\n    res.json(groups);\n  } catch (error) { next(error); }\n});\n\n`;
  if (!s.includes(anchor)) throw new Error('stats anchor missing');
  s = s.replace(anchor, block + anchor);
}

fs.writeFileSync(path, s, 'utf8');
console.log('Accounting transformation grouping enabled.');
