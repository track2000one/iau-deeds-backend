from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')

if "router.delete('/quran-warehouses/:id'" not in text:
    marker = "router.post('/quran-stock/movements', requireRoles('head'), async (req, res, next) => {"
    if marker not in text:
        raise SystemExit('quran stock movement route marker not found')
    block = r'''router.delete('/quran-warehouses/:id', requireRoles('head'), async (req, res, next) => {
  try {
    const warehouse = await prisma.mosqueQuranWarehouse.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, _count: { select: { movements: true } } },
    });
    if (!warehouse) return res.status(404).json({ message: 'مستودع المصاحف غير موجود' });
    if (warehouse._count.movements > 0) {
      return res.status(409).json({
        message: 'لا يمكن حذف المستودع لأنه مرتبط بحركات مخزون محفوظة. حفاظًا على السجل المحاسبي يمكنك تعديل المستودع وإلغاء تفعيله بدلًا من الحذف.',
      });
    }

    await prisma.mosqueQuranWarehouse.delete({ where: { id: warehouse.id } });
    try {
      await prisma.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          action: 'DELETE_QURAN_WAREHOUSE',
          entity: 'MosqueQuranWarehouse',
          entityId: warehouse.id,
          details: { name: warehouse.name },
        },
      });
    } catch (auditError) {
      console.warn('Unable to create Quran warehouse deletion audit log:', auditError?.message || auditError);
    }
    res.status(204).send();
  } catch (error) { next(error); }
});

'''
    text = text.replace(marker, block + marker, 1)

path.write_text(text, encoding='utf-8')
print('Added Quran warehouse delete endpoint.')
