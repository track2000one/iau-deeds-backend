const fs = require('fs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(before, after);
}

const path = 'src/routes/assets.routes.js';
let src = fs.readFileSync(path, 'utf8');

src = replaceOnce(
  src,
  "      const record = await tx.asset.update({ where: { id: existing.id }, data: normalizeAssetData(input, { barcode, purchaseDate, serviceDate, lastInventoryDate }) });",
  "      const updateData = normalizeAssetData(input, { barcode, purchaseDate, serviceDate, lastInventoryDate });\n      // createdAt is the immutable first-entry timestamp. Never allow edits/import refreshes to change it.\n      const record = await tx.asset.update({ where: { id: existing.id }, data: { ...updateData, createdAt: existing.createdAt } });",
  'preserve createdAt on asset update'
);

fs.writeFileSync(path, src);
console.log('Asset immutable entry date safeguard applied.');
