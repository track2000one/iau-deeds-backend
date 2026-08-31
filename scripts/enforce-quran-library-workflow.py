from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')


def rep(old: str, new: str, *, required: bool = False) -> None:
    global text
    if old in text:
        text = text.replace(old, new)
    elif required:
        raise SystemExit(f'Missing required backend snippet: {old[:160]}')


# Protect the business rule server-side: once a baseline inventory exists,
# a mosque/prayer-room balance cannot be increased through physical inventory.
# New Qurans must be added through the library-backed movement, which deducts
# the library balance atomically.
old = """    const totalCount = input.largeCount + input.mediumCount + input.smallCount;
    if (input.damagedCount > totalCount) {
      return res.status(400).json({ message: 'عدد المصاحف التالفة لا يمكن أن يتجاوز إجمالي المصاحف حسب الأحجام' });
    }

    const row = await prisma.mosqueQuranInventory.create({"""
new = """    const totalCount = input.largeCount + input.mediumCount + input.smallCount;
    if (input.damagedCount > totalCount) {
      return res.status(400).json({ message: 'عدد المصاحف التالفة لا يمكن أن يتجاوز إجمالي المصاحف حسب الأحجام' });
    }

    const currentStock = await getQuranSiteSystemStock(prisma, site.id);
    if (currentStock.latestInventory && (
      input.largeCount > currentStock.systemStock.largeCount ||
      input.mediumCount > currentStock.systemStock.mediumCount ||
      input.smallCount > currentStock.systemStock.smallCount
    )) {
      return res.status(400).json({
        message: 'زيادة رصيد المسجد أو المصلى تتم من «إضافة من المكتبة» ليتم الخصم تلقائيًا من مكتبة المصاحف',
      });
    }

    const row = await prisma.mosqueQuranInventory.create({"""
rep(old, new, required=True)

# User-facing terminology. Internal DB/API identifiers remain unchanged for compatibility.
for old, new in [
    ("مستودع المصاحف غير موجود", "مكتبة المصاحف غير موجودة"),
    ("لا يمكن حذف المستودع لأنه مرتبط بحركات مخزون محفوظة. حفاظًا على السجل المحاسبي يمكنك تعديل المستودع وإلغاء تفعيله بدلًا من الحذف.", "لا يمكن حذف المكتبة لأنها مرتبطة بحركات مصاحف محفوظة. حفاظًا على السجل يمكنك تعديل المكتبة وإلغاء تفعيلها بدلًا من الحذف."),
    ("حذف مستودع مصاحف:", "حذف مكتبة مصاحف:"),
    ("المسجد أو المصلى إلزامي في عمليات التوزيع والإرجاع", "المسجد أو المصلى إلزامي في عمليات إضافة المصاحف والإرجاع"),
    ("المستودع غير موجود", "مكتبة المصاحف غير موجودة"),
    ("المستودع غير نشط ولا يقبل حركات جديدة", "مكتبة المصاحف غير مفعلة ولا تقبل حركات جديدة"),
    ("تم صرف مصاحف للموقع", "تمت إضافة مصاحف للموقع"),
    ("تم توزيع ${movement.totalCount} مصحفًا على ${movement.site?.name || 'الموقع'} بموجب ${movement.movementNumber}", "تمت إضافة ${movement.totalCount} مصحفًا إلى ${movement.site?.name || 'الموقع'} من مكتبة المصاحف بموجب ${movement.movementNumber}"),
    ("حركة مخزون مصاحف ${movement.movementNumber}", "حركة مصاحف ${movement.movementNumber}"),
    ("سبب التراجع عن حركة الصرف إلزامي", "سبب التراجع عن إضافة المصاحف إلزامي"),
    ("التراجع المباشر متاح لحركات الصرف والتوزيع فقط", "التراجع المباشر متاح لحركات إضافة المصاحف للمواقع فقط"),
    ("حركة الصرف غير مرتبطة بمسجد أو مصلى", "حركة إضافة المصاحف غير مرتبطة بمسجد أو مصلى"),
    ("لا يمكن التراجع لأن رصيد الموقع الحالي أقل من كمية حركة الصرف.", "لا يمكن التراجع لأن رصيد الموقع الحالي أقل من كمية المصاحف المضافة."),
    ("المستودع المرتبط بالحركة غير موجود", "مكتبة المصاحف المرتبطة بالحركة غير موجودة"),
    ("تم التراجع عن صرف مصاحف", "تم التراجع عن إضافة مصاحف"),
    ("تم عكس حركة الصرف ${original.movementNumber} وإعادة ${original.totalCount} مصحفًا إلى ${original.warehouse?.name || 'المستودع'} بموجب ${reversal.movementNumber}", "تم عكس إضافة المصاحف ${original.movementNumber} وإعادة ${original.totalCount} مصحفًا إلى ${original.warehouse?.name || 'مكتبة المصاحف'} بموجب ${reversal.movementNumber}"),
    ("تراجع عن حركة صرف المصاحف ${original.movementNumber} بواسطة حركة الإرجاع ${reversal.movementNumber}", "تراجع عن إضافة المصاحف ${original.movementNumber} بواسطة حركة الإرجاع ${reversal.movementNumber}"),
]:
    rep(old, new)

# Compatibility guard: keep this persisted prefix so old and new reversal rows are recognized together.
if "notes: `تراجع عن حركة الصرف ${original.movementNumber} — ${reason}`" not in text:
    raise SystemExit('Legacy reversal note prefix was unexpectedly changed')

if 'زيادة رصيد المسجد أو المصلى تتم من «إضافة من المكتبة»' not in text:
    raise SystemExit('Library-backed site increase enforcement is missing')

path.write_text(text, encoding='utf-8')
print('Enforced Quran library-backed site additions and updated user-facing terminology.')
