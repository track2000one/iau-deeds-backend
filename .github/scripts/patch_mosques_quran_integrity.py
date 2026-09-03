from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    text = text.replace(old, new, 1)


tracking = "const trackingNumber = (prefix) => `${prefix}-${new Date().getFullYear()}-${randomDigits(8)}`;"
tracking_with_helpers = tracking + """

const toAuditJson = (value) => {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
};

const runSerializableTransaction = async (callback, maxRetries = 3) => {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: 'Serializable',
        maxWait: 10000,
        timeout: 30000,
      });
    } catch (error) {
      lastError = error;
      if (error?.code !== 'P2034' || attempt === maxRetries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw lastError;
};"""
replace_once(tracking, tracking_with_helpers, 'serializable helper')

replace_once(
    "    const movement = await prisma.$transaction(async (tx) => {",
    "    const movement = await runSerializableTransaction(async (tx) => {",
    'movement serializable transaction',
)

movement_return = """      const created = await tx.mosqueQuranStockMovement.create({
        data: {
          movementNumber: trackingNumber('QMV'),
          movementType: input.movementType,
          warehouseId: warehouse.id,
          siteId: site?.id || null,
          ...counts,
          referenceNumber: nullableText(input.referenceNumber),
          movementAt: input.movementAt || new Date(),
          notes: nullableText(input.notes),
          createdBy: req.authUser?.id || null,
          createdByName: req.authUser?.username || req.authUser?.email || null,
        },
        include: { warehouse: { select: { id: true, code: true, name: true } }, site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } } },
      });
      return created;
    });"""
movement_return_audited = """      const created = await tx.mosqueQuranStockMovement.create({
        data: {
          movementNumber: trackingNumber('QMV'),
          movementType: input.movementType,
          warehouseId: warehouse.id,
          siteId: site?.id || null,
          ...counts,
          referenceNumber: nullableText(input.referenceNumber),
          movementAt: input.movementAt || new Date(),
          notes: nullableText(input.notes),
          createdBy: req.authUser?.id || null,
          createdByName: req.authUser?.username || req.authUser?.email || null,
        },
        include: { warehouse: { select: { id: true, code: true, name: true } }, site: { select: { id: true, name: true, siteType: true, prayerRoomGender: true } } },
      });
      await tx.auditLog.create({ data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action: `quran_stock_${created.movementType}`,
        module: 'mosques',
        entity: 'MosqueQuranStockMovement',
        entityId: created.id,
        entityLabel: created.movementNumber,
        description: `حركة مصاحف ${created.movementNumber} — إجمالي ${created.totalCount}`,
        newData: toAuditJson(created),
      } });
      return created;
    });"""
replace_once(movement_return, movement_return_audited, 'movement atomic audit')

outside_movement_audit = """
    try {
      await prisma.auditLog.create({ data: {
        userId: req.authUser?.id || null, username: req.authUser?.username || null, userEmail: req.authUser?.email || null, userRole: req.authUser?.role || null,
        action: `quran_stock_${movement.movementType}`, module: 'mosques', entity: 'MosqueQuranStockMovement', entityId: movement.id, entityLabel: movement.movementNumber,
        description: `حركة مصاحف ${movement.movementNumber} — إجمالي ${movement.totalCount}`, newData: movement,
      } });
    } catch {}
"""
replace_once(outside_movement_audit, "\n", 'remove non-atomic movement audit')

replace_once(
    "    const reversal = await prisma.$transaction(async (tx) => {",
    "    const reversal = await runSerializableTransaction(async (tx) => {\n      const duplicateReversal = await tx.mosqueQuranStockMovement.findFirst({\n        where: { movementType: 'return', warehouseId: original.warehouseId, siteId: original.siteId, referenceNumber: original.movementNumber },\n        orderBy: { createdAt: 'desc' },\n      });\n      if (duplicateReversal) {\n        const error = new Error(`تم التراجع عن هذه الحركة مسبقًا بموجب ${duplicateReversal.movementNumber}`);\n        error.statusCode = 409;\n        throw error;\n      }",
    'reversal serializable transaction',
)

reverse_create = """      return tx.mosqueQuranStockMovement.create({
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
    });"""
reverse_create_audited = """      const created = await tx.mosqueQuranStockMovement.create({
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
      await tx.auditLog.create({ data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action: 'quran_stock_reverse_distribution',
        module: 'mosques',
        entity: 'MosqueQuranStockMovement',
        entityId: original.id,
        entityLabel: original.movementNumber,
        description: `تراجع عن إضافة المصاحف ${original.movementNumber} بواسطة حركة الإرجاع ${created.movementNumber}`,
        details: toAuditJson({ reason, reversalMovementId: created.id, reversalMovementNumber: created.movementNumber }),
        previousData: toAuditJson(original),
        newData: toAuditJson(created),
      } });
      return created;
    });"""
replace_once(reverse_create, reverse_create_audited, 'reversal atomic audit')

outside_reverse_audit = """
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
        description: `تراجع عن إضافة المصاحف ${original.movementNumber} بواسطة حركة الإرجاع ${reversal.movementNumber}`,
        details: { reason, reversalMovementId: reversal.id, reversalMovementNumber: reversal.movementNumber },
        oldData: original,
        newData: reversal,
      } });
    } catch {}
"""
replace_once(outside_reverse_audit, "\n", 'remove non-atomic reverse audit')

path.write_text(text)
