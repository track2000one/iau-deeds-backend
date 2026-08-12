const fs = require('fs');
const path = 'src/routes/accounting-transformation.routes.js';
let s = fs.readFileSync(path, 'utf8');

if (!s.includes("router.post('/bulk-preview'")) {
  const anchor = "router.post('/bulk-import', async (req, res, next) => {";
  const block = `router.post('/bulk-preview', async (req, res, next) => {\n  try {\n    const input = bulkImportSchema.parse(req.body);\n    const fingerprints = [];\n    const invalidIndexes = [];\n    const seen = new Set();\n    const duplicateIndexes = [];\n\n    input.items.forEach((item, index) => {\n      const payload = item.payload || {};\n      if (!hasAccountingValue(payload.B) && !hasAccountingValue(payload.E) && !hasAccountingValue(payload.G)) {\n        invalidIndexes.push(index);\n        return;\n      }\n      const fingerprint = createFingerprint(item.recordType, payload);\n      if (seen.has(fingerprint)) {\n        duplicateIndexes.push(index);\n        return;\n      }\n      seen.add(fingerprint);\n      fingerprints.push({ index, fingerprint });\n    });\n\n    const existing = fingerprints.length\n      ? await prisma.accountingTransformationRecord.findMany({\n          where: { sourceFingerprint: { in: fingerprints.map((item) => item.fingerprint) } },\n          select: { sourceFingerprint: true },\n        })\n      : [];\n    const existingSet = new Set(existing.map((item) => item.sourceFingerprint).filter(Boolean));\n    fingerprints.forEach((item) => {\n      if (existingSet.has(item.fingerprint)) duplicateIndexes.push(item.index);\n    });\n\n    const duplicateSet = new Set(duplicateIndexes);\n    const invalidSet = new Set(invalidIndexes);\n    const freshIndexes = input.items.map((_, index) => index).filter((index) => !duplicateSet.has(index) && !invalidSet.has(index));\n\n    res.json({\n      total: input.items.length,\n      fresh: freshIndexes.length,\n      duplicate: duplicateSet.size,\n      invalid: invalidSet.size,\n      freshIndexes,\n      duplicateIndexes: Array.from(duplicateSet).sort((a, b) => a - b),\n      invalidIndexes: Array.from(invalidSet).sort((a, b) => a - b),\n    });\n  } catch (error) {\n    next(error);\n  }\n});\n\n`;
  if (!s.includes(anchor)) throw new Error('bulk-import anchor missing');
  s = s.replace(anchor, block + anchor);
}

const oldExisting = `      if (existing) {\n        await prisma.accountingTransformationRecord.update({\n          where: { id: existing.id },\n          data,\n        });\n        updated += 1;\n      } else {`;
const newExisting = `      if (existing) {\n        skipped += 1;\n      } else {`;
if (s.includes(oldExisting)) s = s.replace(oldExisting, newExisting);

fs.writeFileSync(path, s, 'utf8');
console.log('Accounting transformation import preview/batches backend enabled.');
