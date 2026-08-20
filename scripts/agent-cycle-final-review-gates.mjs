import fs from 'node:fs';

const replaceOnce = (file, from, to, label) => {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) {
    if (text.includes(to)) return;
    throw new Error(`Patch target not found: ${label}`);
  }
  fs.writeFileSync(file, text.replace(from, to));
};

replaceOnce(
  'src/routes/asset-cycles.routes.js',
  "    const pendingReview = await prisma.assetCycleRecord.count({ where: { cycleId: cycle.id, reviewStatus: 'needs_review' } });\n    if (pendingReview) return res.status(409).json({ message: `يوجد ${pendingReview} سجل يحتاج مراجعة وتأكيد قبل اعتماد الدورة.` });\n\n    const carriedForward = await carryForwardUnchangedAssetRecords(cycle);",
  "    const carriedForward = await carryForwardUnchangedAssetRecords(cycle);\n    const pendingReview = await prisma.assetCycleRecord.count({ where: { cycleId: cycle.id, reviewStatus: 'needs_review' } });\n    if (pendingReview) return res.status(409).json({ message: `يوجد ${pendingReview} سجل يحتاج مراجعة وتأكيد قبل اعتماد الدورة.` });",
  'asset final review after carry-forward',
);

replaceOnce(
  'src/routes/accounting-cycles.routes.js',
  "    const unresolved = await prisma.accountingTransformationRecord.count({\n      where: { cycleId: cycle.id, committeeStatus: { in: ['not_reviewed', 'under_review', 'needs_update'] } },\n    });\n    if (unresolved) {\n      return res.status(409).json({ message: `لا يمكن اعتماد الدورة: يوجد ${unresolved} سجل لم تُحسم مراجعته أو يحتاج تحديثًا.` });\n    }\n\n    const carriedForward = await carryForwardUnchangedAccountingRecords(cycle);",
  "    const carriedForward = await carryForwardUnchangedAccountingRecords(cycle);\n    const unresolved = await prisma.accountingTransformationRecord.count({\n      where: { cycleId: cycle.id, committeeStatus: { in: ['not_reviewed', 'under_review', 'needs_update'] } },\n    });\n    if (unresolved) {\n      return res.status(409).json({ message: `لا يمكن اعتماد الدورة: يوجد ${unresolved} سجل لم تُحسم مراجعته أو يحتاج تحديثًا.` });\n    }",
  'accounting final review after carry-forward',
);

console.log('Final merged-cycle review gates applied successfully.');
