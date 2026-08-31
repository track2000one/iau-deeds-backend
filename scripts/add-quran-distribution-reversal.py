from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')

marker = "// -----------------------------------------------------------------------------\n// Quran inventory: each save creates a dated snapshot. The latest snapshot is\n"
if marker not in text:
    raise SystemExit('Quran inventory marker not found')

if "router.post('/quran-stock/movements/:id/reverse'" not in text:
    endpoint = r'''router.post('/quran-stock/movements/:id/reverse', requireRoles('head'), async (req, res, next) => {
  try {
    const reason = nullableText(req.body?.reason);
    if (!reason || reason.length < 3) return res.status(400).json({ message: 'سبب التراجع عن حركة الصرف إلزامي' });

    const original = await prisma.mosqueQuranStockMovement.findUnique({
      where: { id: req.params.id },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } },
      },
    });
    if (!original) return res.status(404).json({ message: 'حركة المصاحف غير موجودة' });
    if (original.movementType !== 'distribution') {
      return res.status(400).json({ message: 'التراجع المباشر متاح لحركات الصرف والتوزيع فقط' });
    }
    if (!original.siteId) return res.status(400).json({ message: 'حركة الصرف غير مرتبطة بمسجد أو مصلى' });

    const priorReversal = await prisma.mosqueQuranStockMovement.findFirst({
      where: {
        movementType: 'return',
        warehouseId: original.warehouseId,
        siteId: original.siteId,
        referenceNumber: original.movementNumber,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (priorReversal) {
      return res.status(409).json({ message: `تم التراجع عن هذه الحركة مسبقًا بموجب ${priorReversal.movementNumber}` });
    }

    const counts = quranMovementCounts(original);
    const reversal = await prisma.$transaction(async (tx) => {
      const current = await getQuranSiteSystemStock(tx, original.siteId);
      if (!quranHasEnough(current.systemStock, counts)) {
        const error = new Error(`لا يمكن التراجع لأن رصيد الموقع الحالي أقل من كمية حركة الصرف. الرصيد: كبير ${current.systemStock.largeCount}، متوسط ${current.systemStock.mediumCount}، صغير ${current.systemStock.smallCount}`);
        error.statusCode = 400;
        throw error;
      }

      const warehouse = await tx.mosqueQuranWarehouse.findUnique({ where: { id: original.warehouseId } });
      if (!warehouse) {
        const error = new Error('المستودع المرتبط بالحركة غير موجود');
        error.statusCode = 404;
        throw error;
      }
      const site = await tx.mosqueSite.findUnique({
        where: { id: original.siteId },
        select: { id: true, name: true, siteType: true, prayerRoomGender: true },
      });
      if (!site) {
        const error = new Error('المسجد أو المصلى المرتبط بالحركة غير موجود');
        error.statusCode = 404;
        throw error;
      }

      return tx.mosqueQuranStockMovement.create({
        data: {
          movementNumber: trackingNumber('QMV'),
          movementType: 'return',
          warehouseId: original.warehouseId,
          siteId: original.siteId,
          ...counts,
          referenceNumber: original.movementNumber,
          movementAt: new Date(),
          notes: `تراجع عن حركة الصرف ${original.movementNumber} — ${reason}`,
          createdBy: req.authUser?.id || null,
          createdByName: req.authUser?.username || req.authUser?.email || null,
        },
        include: {
          warehouse: { select: { id: true, code: true, name: true } },
          site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } },
        },
      });
    });

    await notify({
      siteId: original.siteId,
      title: 'تم التراجع عن صرف مصاحف',
      message: `تم عكس حركة الصرف ${original.movementNumber} وإعادة ${original.totalCount} مصحفًا إلى ${original.warehouse?.name || 'المستودع'} بموجب ${reversal.movementNumber}`,
      entityType: 'quran_stock_movement',
      entityId: reversal.id,
    });

    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action: 'quran_stock_reverse_distribution',
        module: 'mosques',
        entity: 'MosqueQuranStockMovement',
        entityId: original.id,
        entityLabel: original.movementNumber,
        description: `تراجع عن حركة صرف المصاحف ${original.movementNumber} بواسطة حركة الإرجاع ${reversal.movementNumber}`,
        details: { reason, reversalMovementId: reversal.id, reversalMovementNumber: reversal.movementNumber },
        oldData: original,
        newData: reversal,
      } });
    } catch {}

    res.status(201).json({ reversedMovementId: original.id, reversal });
  } catch (error) { next(error); }
});

'''
    text = text.replace(marker, endpoint + marker, 1)

path.write_text(text, encoding='utf-8')
print('Added auditable reversal endpoint for Quran distribution movements.')
