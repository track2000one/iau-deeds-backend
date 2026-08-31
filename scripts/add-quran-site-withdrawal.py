from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')
original = text

replacements = [
    (
        "movementType: z.enum(['receipt', 'distribution', 'return', 'warehouse_damage', 'adjustment_in', 'adjustment_out']),",
        "movementType: z.enum(['receipt', 'distribution', 'return', 'site_withdrawal', 'warehouse_damage', 'adjustment_in', 'adjustment_out']),",
    ),
    (
        "const QURAN_SITE_NEGATIVE_TYPES = new Set(['return']);",
        "const QURAN_SITE_NEGATIVE_TYPES = new Set(['return', 'site_withdrawal']);",
    ),
    (
        "movementType: { in: ['distribution', 'return'] }",
        "movementType: { in: ['distribution', 'return', 'site_withdrawal'] }",
    ),
    (
        "if (['distribution', 'return'].includes(input.movementType) && !input.siteId) return res.status(400).json({ message: 'المسجد أو المصلى إلزامي في عمليات إضافة المصاحف والإرجاع' });",
        "if (['distribution', 'return', 'site_withdrawal'].includes(input.movementType) && !input.siteId) return res.status(400).json({ message: 'المسجد أو المصلى إلزامي في عمليات إضافة المصاحف والإرجاع والسحب' });",
    ),
    (
        "if (input.movementType === 'return' && site) {",
        "if (['return', 'site_withdrawal'].includes(input.movementType) && site) {",
    ),
    (
        "const error = new Error(`لا يمكن إرجاع كمية أكبر من الرصيد النظامي للموقع. الرصيد: كبير ${current.systemStock.largeCount}، متوسط ${current.systemStock.mediumCount}، صغير ${current.systemStock.smallCount}`);",
        "const error = new Error(`لا يمكن تسجيل كمية أكبر من الرصيد النظامي للموقع. الرصيد: كبير ${current.systemStock.largeCount}، متوسط ${current.systemStock.mediumCount}، صغير ${current.systemStock.smallCount}`);",
    ),
]

for old, new in replacements:
    if old not in text:
        raise SystemExit(f'Missing expected backend pattern: {old[:120]}')
    text = text.replace(old, new)

old_site_stock = """    const siteStock = sites.map((site) => {
      const latestInventory = latestBySite.get(site.id) || null;
      const systemStock = quranSiteStockFromRows(latestInventory, movementsBySite.get(site.id) || []);
      return { site, latestInventory, systemStock };
    });"""
new_site_stock = """    const siteStock = sites.map((site) => {
      const latestInventory = latestBySite.get(site.id) || null;
      const movementRows = movementsBySite.get(site.id) || [];
      const systemStock = quranSiteStockFromRows(latestInventory, movementRows);
      const withdrawnStock = movementRows
        .filter((row) => row.movementType === 'site_withdrawal')
        .reduce((counts, row) => addQuranCounts(counts, quranMovementCounts(row), 1), quranZeroCounts());
      return { site, latestInventory, systemStock, withdrawnStock };
    });"""
if old_site_stock not in text:
    raise SystemExit('Missing siteStock dashboard block')
text = text.replace(old_site_stock, new_site_stock)

old_summary = """      returnedTotal: allWarehouseMovements.filter((row) => row.movementType === 'return').reduce((sum, row) => sum + row.totalCount, 0),
      damagedTotal: allWarehouseMovements.filter((row) => row.movementType === 'warehouse_damage').reduce((sum, row) => sum + row.totalCount, 0),"""
new_summary = """      returnedTotal: allWarehouseMovements.filter((row) => row.movementType === 'return').reduce((sum, row) => sum + row.totalCount, 0),
      withdrawnTotal: allWarehouseMovements.filter((row) => row.movementType === 'site_withdrawal').reduce((sum, row) => sum + row.totalCount, 0),
      damagedTotal: allWarehouseMovements.filter((row) => row.movementType === 'warehouse_damage').reduce((sum, row) => sum + row.totalCount, 0),"""
if old_summary not in text:
    raise SystemExit('Missing quran stock dashboard summary block')
text = text.replace(old_summary, new_summary)

old_notify = """    if (movement.movementType === 'distribution' && movement.siteId) {
      await notify({ siteId: movement.siteId, title: 'تمت إضافة مصاحف للموقع', message: `تمت إضافة ${movement.totalCount} مصحفًا إلى ${movement.site?.name || 'الموقع'} من مكتبة المصاحف بموجب ${movement.movementNumber}`, entityType: 'quran_stock_movement', entityId: movement.id });
    }
"""
new_notify = """    if (movement.movementType === 'distribution' && movement.siteId) {
      await notify({ siteId: movement.siteId, title: 'تمت إضافة مصاحف للموقع', message: `تمت إضافة ${movement.totalCount} مصحفًا إلى ${movement.site?.name || 'الموقع'} من مكتبة المصاحف بموجب ${movement.movementNumber}`, entityType: 'quran_stock_movement', entityId: movement.id });
    }
    if (movement.movementType === 'site_withdrawal' && movement.siteId) {
      await notify({ siteId: movement.siteId, title: 'تم سحب مصاحف من الموقع', message: `تم سحب ${movement.totalCount} مصحفًا من ${movement.site?.name || 'الموقع'} بموجب ${movement.movementNumber}. الكمية المسحوبة لا تعاد تلقائيًا إلى رصيد مكتبة المصاحف.`, entityType: 'quran_stock_movement', entityId: movement.id });
    }
"""
if old_notify not in text:
    raise SystemExit('Missing distribution notification block')
text = text.replace(old_notify, new_notify)

# Keep operational comments aligned with the new ledger behavior.
text = text.replace(
    "// applies subsequent distribution/return movements, keeping physical counts and",
    "// applies subsequent distribution/return/site-withdrawal movements, keeping physical counts and",
)

if text == original:
    raise SystemExit('No backend changes applied')

path.write_text(text, encoding='utf-8')
print('Quran site-withdrawal backend workflow added')
