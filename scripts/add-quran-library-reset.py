from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')

marker = "router.post('/quran-stock/movements', requireRoles('head'), async (req, res, next) => {"
if marker not in text:
    raise SystemExit('Quran stock movement route marker not found')
if "router.post('/quran-stock/reset'" in text:
    print('Quran library reset endpoint already exists')
    raise SystemExit(0)

endpoint = r'''router.post('/quran-stock/reset', requireRoles('head'), async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || '').trim();
    if (confirmation !== 'تصفير مكتبة المصاحف') {
      return res.status(400).json({ message: 'لتنفيذ التصفير اكتب عبارة التأكيد: تصفير مكتبة المصاحف' });
    }

    const reset = await prisma.$transaction(async (tx) => {
      const [warehouses, movements, inventories, notifications] = await Promise.all([
        tx.mosqueQuranWarehouse.count(),
        tx.mosqueQuranStockMovement.count(),
        tx.mosqueQuranInventory.count(),
        tx.mosqueNotification.count({ where: { entityType: 'quran_stock_movement' } }),
      ]);

      // Delete dependent records first because stock movements restrict warehouse deletion.
      await tx.mosqueQuranStockMovement.deleteMany({});
      await tx.mosqueQuranInventory.deleteMany({});
      await tx.mosqueNotification.deleteMany({ where: { entityType: 'quran_stock_movement' } });
      await tx.mosqueQuranWarehouse.deleteMany({});

      return { warehouses, movements, inventories, notifications };
    });

    try {
      await prisma.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: 'RESET_QURAN_LIBRARY',
          module: 'mosques',
          entity: 'MosqueQuranWarehouse',
          entityLabel: 'مكتبة المصاحف',
          description: 'تصفير كامل لمكتبة المصاحف وبيانات حركات وجرد المصاحف للبدء من الصفر',
          details: reset,
        },
      });
    } catch (auditError) {
      console.warn('Unable to create Quran library reset audit log:', auditError?.message || auditError);
    }

    res.json({
      message: 'تم تصفير مكتبة المصاحف بالكامل ويمكن الآن البدء من الصفر',
      reset,
    });
  } catch (error) { next(error); }
});

'''

text = text.replace(marker, endpoint + marker, 1)
path.write_text(text, encoding='utf-8')
print('Added protected Quran library reset endpoint.')
