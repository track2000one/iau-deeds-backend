from pathlib import Path

schema_path = Path('prisma/schema.prisma')
routes_path = Path('src/routes/mosques.routes.js')

schema = schema_path.read_text(encoding='utf-8')
routes = routes_path.read_text(encoding='utf-8')

# 1) Persist the target Quran quantity per mosque/prayer room.
old = '  capacity         Int?\n  latitude         Float?'
new = '  capacity         Int?\n  quranTargetCount Int?\n  latitude         Float?'
if 'quranTargetCount Int?' not in schema:
    if old not in schema:
        raise SystemExit('MosqueSite capacity anchor not found in schema')
    schema = schema.replace(old, new, 1)

# 2) Accept the target quantity through the normal site create/update API.
old = "  capacity: z.coerce.number().int().nonnegative().optional().nullable(),\n  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),"
new = "  capacity: z.coerce.number().int().nonnegative().optional().nullable(),\n  quranTargetCount: z.coerce.number().int().min(0).max(1000000).optional().nullable(),\n  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),"
if 'quranTargetCount: z.coerce.number()' not in routes:
    if old not in routes:
        raise SystemExit('siteSchema capacity anchor not found')
    routes = routes.replace(old, new, 1)

# 3) Include the target in the Quran dashboard site projection.
old = "select: { id: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true, campusLocation: true },"
new = "select: { id: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true, campusLocation: true, quranTargetCount: true },"
if 'campusLocation: true, quranTargetCount: true' not in routes:
    if old not in routes:
        raise SystemExit('Quran dashboard site select anchor not found')
    routes = routes.replace(old, new, 1)

# 4) Compute target, automatic need, coverage and a concise need level from the system stock.
old = """      const withdrawnStock = movementRows
        .filter((row) => row.movementType === 'site_withdrawal')
        .reduce((counts, row) => addQuranCounts(counts, quranMovementCounts(row), 1), quranZeroCounts());
      return { site, latestInventory, systemStock, withdrawnStock };
"""
new = """      const withdrawnStock = movementRows
        .filter((row) => row.movementType === 'site_withdrawal')
        .reduce((counts, row) => addQuranCounts(counts, quranMovementCounts(row), 1), quranZeroCounts());
      const targetCount = Math.max(0, Number(site.quranTargetCount || 0));
      const needCount = targetCount > 0 ? Math.max(targetCount - systemStock.totalCount, 0) : 0;
      const coveragePercent = targetCount > 0
        ? Math.min(100, Math.round((systemStock.totalCount / targetCount) * 100))
        : null;
      const needLevel = targetCount <= 0
        ? 'not_set'
        : needCount <= 0
          ? 'complete'
          : coveragePercent >= 85
            ? 'low'
            : coveragePercent >= 60
              ? 'medium'
              : 'high';
      return { site, latestInventory, systemStock, withdrawnStock, targetCount, needCount, coveragePercent, needLevel };
"""
if "const targetCount = Math.max(0, Number(site.quranTargetCount || 0));" not in routes:
    if old not in routes:
        raise SystemExit('Quran site stock return anchor not found')
    routes = routes.replace(old, new, 1)

# 5) The dashboard total need is now calculated automatically from target minus current stock.
old = "      siteNeedTotal: siteStock.reduce((sum, row) => sum + Number(row.latestInventory?.neededCount || 0), 0),"
new = "      siteNeedTotal: siteStock.reduce((sum, row) => sum + Number(row.needCount || 0), 0),"
if old in routes:
    routes = routes.replace(old, new, 1)
elif new not in routes:
    raise SystemExit('siteNeedTotal anchor not found')

schema_path.write_text(schema, encoding='utf-8')
routes_path.write_text(routes, encoding='utf-8')
print('Quran target capacity backend patch applied')
