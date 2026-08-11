const fs = require('fs');

const path = 'src/routes/assets.routes.js';
let source = fs.readFileSync(path, 'utf8');

const archiveLine = "      prisma.archiveRecord.create({ data: { entityType: 'asset', entityId: existing.id, documentType: 'أصل', documentNumber: existing.itemNumber || existing.assetNumber, title: existing.name, deletedData: existing, deletedBy } }),\n";
if (!source.includes(archiveLine)) {
  throw new Error('Asset archiveRecord delete target was not found');
}
source = source.replace(archiveLine, '');

const oldAudit = "description: 'حذف أصل ونقله للأرشفة'";
const newAudit = "description: 'حذف أصل مع الاحتفاظ بسجل العملية وبياناته السابقة في سجل العمليات'";
if (!source.includes(oldAudit)) {
  throw new Error('Asset delete audit description target was not found');
}
source = source.replace(oldAudit, newAudit);

fs.writeFileSync(path, source);
console.log('Fixed asset deletion: removed invalid prisma.archiveRecord.create call.');
