from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text()
old = """      damagedTotal: allWarehouseMovements.filter((row) => row.movementType === 'warehouse_damage').reduce((sum, row) => sum + row.totalCount, 0),
      siteSystemTotal: siteStock.reduce((sum, row) => sum + row.systemStock.totalCount, 0),"""
new = """      damagedTotal: allWarehouseMovements.filter((row) => row.movementType === 'warehouse_damage').reduce((sum, row) => sum + row.totalCount, 0),
      adjustmentInTotal: allWarehouseMovements.filter((row) => row.movementType === 'adjustment_in').reduce((sum, row) => sum + row.totalCount, 0),
      adjustmentOutTotal: allWarehouseMovements.filter((row) => row.movementType === 'adjustment_out').reduce((sum, row) => sum + row.totalCount, 0),
      warehouseInflowTotal: allWarehouseMovements.filter((row) => ['receipt', 'return', 'adjustment_in'].includes(row.movementType)).reduce((sum, row) => sum + row.totalCount, 0),
      warehouseOutflowTotal: allWarehouseMovements.filter((row) => ['distribution', 'warehouse_damage', 'adjustment_out'].includes(row.movementType)).reduce((sum, row) => sum + row.totalCount, 0),
      warehouseNetMovement: allWarehouseMovements.reduce((sum, row) => {
        const sign = QURAN_WAREHOUSE_POSITIVE_TYPES.has(row.movementType) ? 1 : QURAN_WAREHOUSE_NEGATIVE_TYPES.has(row.movementType) ? -1 : 0;
        return sum + (sign * row.totalCount);
      }, 0),
      siteSystemTotal: siteStock.reduce((sum, row) => sum + row.systemStock.totalCount, 0),
      systemTotal: warehouseRows.reduce((sum, row) => sum + row.balance.totalCount, 0) + siteStock.reduce((sum, row) => sum + row.systemStock.totalCount, 0),"""
if old in text:
    text = text.replace(old, new, 1)
elif 'warehouseInflowTotal:' not in text:
    raise SystemExit('Unable to locate Quran dashboard summary block')
path.write_text(text)
