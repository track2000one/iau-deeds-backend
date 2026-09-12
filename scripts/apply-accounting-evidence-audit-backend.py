from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)

route = Path('src/routes/accounting-transformation.routes.js')
text = route.read_text(encoding='utf-8')

text = replace_once(
    text,
    "} from '../services/accountingCycles.service.js';\n",
    "} from '../services/accountingCycles.service.js';\nimport {\n  buildEvidenceAuditMirrorRows,\n  hasProtectedEvidenceHistory,\n  preserveEvidenceControlForImport,\n  protectEvidenceAuditPayload,\n} from '../services/accountingEvidenceAudit.service.js';\n",
    'accounting route audit imports',
)

marker = "const accountingGroupKey = (item) => {\n"
helper = """const syncEvidenceAuditMirror = async (db, record) => {
  const rows = buildEvidenceAuditMirrorRows(record, record?.payload || {});
  if (!rows.length) return;
  const ids = rows.map((item) => item.mirrorId);
  const existing = await db.auditLog.findMany({
    where: {
      module: 'accounting_transformation',
      entity: 'accounting_evidence_event',
      entityId: { in: ids },
    },
    select: { entityId: true },
  });
  const existingIds = new Set(existing.map((item) => item.entityId));
  const missing = rows.filter((item) => !existingIds.has(item.mirrorId)).map((item) => item.data);
  if (missing.length) await db.auditLog.createMany({ data: missing });
};

"""
if marker not in text:
    raise SystemExit('accounting route helper marker missing')
text = text.replace(marker, helper + marker, 1)

text = replace_once(
    text,
    "      const fingerprint = createAccountingFingerprint(item.recordType, item.payload || {});\n",
    "      const safePayload = preserveEvidenceControlForImport({}, item.payload || {});\n      const fingerprint = createAccountingFingerprint(item.recordType, safePayload);\n",
    'bulk preview safe fingerprint',
)

old_bulk = """      const sourceFingerprint = createAccountingFingerprint(item.recordType, item.payload || {});
      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});
      const existing = await prisma.accountingTransformationRecord.findFirst({ where: { cycleId: currentCycle.id, sourceFingerprint }, select: { id: true } });
      if (existing) { skipped += 1; continue; }
      rows.push({
        ...buildAccountingSnapshotData(item, req.authUser, { cycleId: currentCycle.id, sourceFingerprint, stableKey, changeType: 'manual' }),
"""
new_bulk = """      const safePayload = preserveEvidenceControlForImport({}, item.payload || {});
      const safeItem = { ...item, payload: safePayload };
      const sourceFingerprint = createAccountingFingerprint(item.recordType, safePayload);
      const stableKey = createAccountingStableKey(item.recordType, safePayload);
      const existing = await prisma.accountingTransformationRecord.findFirst({ where: { cycleId: currentCycle.id, sourceFingerprint }, select: { id: true } });
      if (existing) { skipped += 1; continue; }
      rows.push({
        ...buildAccountingSnapshotData(safeItem, req.authUser, { cycleId: currentCycle.id, sourceFingerprint, stableKey, changeType: 'manual' }),
"""
text = replace_once(text, old_bulk, new_bulk, 'bulk import protected payload')

old_post = """router.post('/', async (req, res, next) => {
  try {
    const input = recordInputSchema.parse(req.body);
    if (!itemIsValid(input)) return res.status(400).json({ message: 'السجل لا يحتوي على هوية أو وصف أصل كافٍ.' });
    const currentCycle = await ensureAccountingTransformationBaseline();
    const sourceFingerprint = createAccountingFingerprint(input.recordType, input.payload || {});
    const stableKey = createAccountingStableKey(input.recordType, input.payload || {});
    let record = null;
    for (let attempt = 0; attempt < 5 && !record; attempt += 1) {
      const recordNumber = await nextAccountingRecordNumber(attempt);
      try {
        record = await prisma.accountingTransformationRecord.create({
          data: {
            ...buildAccountingSnapshotData(input, req.authUser, { cycleId: currentCycle.id, sourceFingerprint, stableKey, changeType: 'manual' }),
            recordNumber,
            createdBy: req.authUser?.email || req.authUser?.username || null,
          },
        });
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
      }
    }
    if (!record) return res.status(409).json({ message: 'تعذر إنشاء رقم سجل فريد، حاول مرة أخرى' });
    res.status(201).json(record);
  } catch (error) { next(error); }
});
"""
new_post = """router.post('/', async (req, res, next) => {
  try {
    const input = recordInputSchema.parse(req.body);
    const protectedAudit = protectEvidenceAuditPayload({}, input.payload || {}, req.authUser);
    const safeInput = { ...input, payload: protectedAudit.payload };
    if (!itemIsValid(safeInput)) return res.status(400).json({ message: 'السجل لا يحتوي على هوية أو وصف أصل كافٍ.' });
    const currentCycle = await ensureAccountingTransformationBaseline();
    const sourceFingerprint = createAccountingFingerprint(safeInput.recordType, safeInput.payload || {});
    const stableKey = createAccountingStableKey(safeInput.recordType, safeInput.payload || {});
    let record = null;
    for (let attempt = 0; attempt < 5 && !record; attempt += 1) {
      const recordNumber = await nextAccountingRecordNumber(attempt);
      try {
        record = await prisma.accountingTransformationRecord.create({
          data: {
            ...buildAccountingSnapshotData(safeInput, req.authUser, { cycleId: currentCycle.id, sourceFingerprint, stableKey, changeType: 'manual' }),
            recordNumber,
            createdBy: req.authUser?.email || req.authUser?.username || null,
          },
        });
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
      }
    }
    if (!record) return res.status(409).json({ message: 'تعذر إنشاء رقم سجل فريد، حاول مرة أخرى' });
    await syncEvidenceAuditMirror(prisma, record);
    res.status(201).json(record);
  } catch (error) { next(error); }
});
"""
text = replace_once(text, old_post, new_post, 'protected POST route')

old_put = """router.put('/:id', async (req, res, next) => {
  try {
    const input = recordInputSchema.parse(req.body);
    if (!itemIsValid(input)) return res.status(400).json({ message: 'السجل لا يحتوي على هوية أو وصف أصل كافٍ.' });
    const current = await prisma.accountingTransformationRecord.findUnique({ where: { id: req.params.id }, include: { cycle: true } });
    if (!current) return res.status(404).json({ message: 'سجل التحول المحاسبي غير موجود' });
    if (current.cycle && current.cycle.status === 'archived') return res.status(409).json({ message: 'الدورات المؤرشفة للعرض التاريخي فقط ولا يمكن تعديل بياناتها' });
    const sourceFingerprint = createAccountingFingerprint(input.recordType, input.payload || {});
    const stableKey = createAccountingStableKey(input.recordType, input.payload || {});
    const record = await prisma.accountingTransformationRecord.update({
      where: { id: req.params.id },
      data: buildAccountingSnapshotData(input, req.authUser, { cycleId: current.cycleId, sourceFingerprint, stableKey, changeType: current.changeType || 'manual' }),
    });
    res.json(record);
  } catch (error) { next(error); }
});
"""
new_put = """router.put('/:id', async (req, res, next) => {
  try {
    const input = recordInputSchema.parse(req.body);
    const record = await prisma.$transaction(async (tx) => {
      const current = await tx.accountingTransformationRecord.findUnique({ where: { id: req.params.id }, include: { cycle: true } });
      if (!current) {
        const error = new Error('سجل التحول المحاسبي غير موجود');
        error.statusCode = 404;
        throw error;
      }
      if (current.cycle && current.cycle.status === 'archived') {
        const error = new Error('الدورات المؤرشفة للعرض التاريخي فقط ولا يمكن تعديل بياناتها');
        error.statusCode = 409;
        throw error;
      }

      const protectedAudit = protectEvidenceAuditPayload(current.payload || {}, input.payload || {}, req.authUser);
      const safeInput = { ...input, payload: protectedAudit.payload };
      if (!itemIsValid(safeInput)) {
        const error = new Error('السجل لا يحتوي على هوية أو وصف أصل كافٍ.');
        error.statusCode = 400;
        throw error;
      }
      const sourceFingerprint = createAccountingFingerprint(safeInput.recordType, safeInput.payload || {});
      const stableKey = createAccountingStableKey(safeInput.recordType, safeInput.payload || {});
      const updated = await tx.accountingTransformationRecord.update({
        where: { id: req.params.id },
        data: buildAccountingSnapshotData(safeInput, req.authUser, { cycleId: current.cycleId, sourceFingerprint, stableKey, changeType: current.changeType || 'manual' }),
      });
      await syncEvidenceAuditMirror(tx, updated);
      return updated;
    });
    res.json(record);
  } catch (error) { next(error); }
});
"""
text = replace_once(text, old_put, new_put, 'protected PUT route')

old_delete_line = "    if (current.cycle && current.cycle.status === 'archived') return res.status(409).json({ message: 'الدورات المؤرشفة محفوظة كسجل تاريخي ولا يمكن حذف بياناتها' });\n    await prisma.accountingTransformationRecord.delete({ where: { id: req.params.id } });\n"
new_delete_line = "    if (current.cycle && current.cycle.status === 'archived') return res.status(409).json({ message: 'الدورات المؤرشفة محفوظة كسجل تاريخي ولا يمكن حذف بياناتها' });\n    if (hasProtectedEvidenceHistory(current.payload || {})) return res.status(409).json({ message: 'لا يمكن حذف سجل يحتوي على أحداث رقابية لمستندات الإثبات. احتفظ بالسجل ضمن دورة البيانات أو أرشفه بدل الحذف.' });\n    await prisma.accountingTransformationRecord.delete({ where: { id: req.params.id } });\n"
text = replace_once(text, old_delete_line, new_delete_line, 'protected DELETE route')
route.write_text(text, encoding='utf-8')

# Cycle re-import: spreadsheet data cannot overwrite protected control/audit data.
reimport = Path('src/routes/accounting-cycle-reimport.routes.js')
text = reimport.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import { hasAccountingValue } from '../config/accountingTransformation.js';\n",
    "import { hasAccountingValue } from '../config/accountingTransformation.js';\nimport { preserveEvidenceControlForImport } from '../services/accountingEvidenceAudit.service.js';\n",
    'cycle reimport audit import',
)

old_preview_merge = """      const previous = baseByKey.get(matchKey);
      const canMerge = previous && previous.recordType === item.recordType;
      const mergedPayload = canMerge ? mergeAccountingPayload(previous.payload || {}, item.payload || {}) : (item.payload || {});
      const { fingerprint, changeType } = classifyAgainstBase(item, previous, mergedPayload);

      if (changeType === 'new') newIndexes.push(index);
      else if (changeType === 'modified') modifiedIndexes.push(index);
      else unchangedIndexes.push(index);

      const target = targetByKey.get(matchKey);
"""
new_preview_merge = """      const previous = baseByKey.get(matchKey);
      const target = targetByKey.get(matchKey);
      const canMerge = previous && previous.recordType === item.recordType;
      const accountingPayload = canMerge ? mergeAccountingPayload(previous.payload || {}, item.payload || {}) : (item.payload || {});
      const auditSourcePayload = target?.payload || previous?.payload || {};
      const mergedPayload = preserveEvidenceControlForImport(auditSourcePayload, accountingPayload);
      const { fingerprint, changeType } = classifyAgainstBase(item, previous, mergedPayload);

      if (changeType === 'new') newIndexes.push(index);
      else if (changeType === 'modified') modifiedIndexes.push(index);
      else unchangedIndexes.push(index);

"""
text = replace_once(text, old_preview_merge, new_preview_merge, 'cycle preview protected merge')

old_import_merge = """      const previous = baseByKey.get(matchKey);
      const canMerge = previous && previous.recordType === item.recordType;
      const mergedPayload = canMerge ? mergeAccountingPayload(previous.payload || {}, item.payload || {}) : (item.payload || {});
      const { fingerprint: sourceFingerprint, changeType } = classifyAgainstBase(item, previous, mergedPayload);
      const target = targetByKey.get(matchKey);
"""
new_import_merge = """      const previous = baseByKey.get(matchKey);
      const target = targetByKey.get(matchKey);
      const canMerge = previous && previous.recordType === item.recordType;
      const accountingPayload = canMerge ? mergeAccountingPayload(previous.payload || {}, item.payload || {}) : (item.payload || {});
      const auditSourcePayload = target?.payload || previous?.payload || {};
      const mergedPayload = preserveEvidenceControlForImport(auditSourcePayload, accountingPayload);
      const { fingerprint: sourceFingerprint, changeType } = classifyAgainstBase(item, previous, mergedPayload);
"""
text = replace_once(text, old_import_merge, new_import_merge, 'cycle import protected merge')
reimport.write_text(text, encoding='utf-8')

# Internal audit metadata must not change the accounting-content fingerprint.
cycles = Path('src/services/accountingCycles.service.js')
text = cycles.read_text(encoding='utf-8')
old_fp = """const fingerprintPayload = (recordType, payload = {}) =>
  recordType === 'fixed_asset' ? calculateModelBDerivedPayload(payload) : payload;
"""
new_fp = """const fingerprintPayload = (recordType, payload = {}) => {
  const source = recordType === 'fixed_asset' ? calculateModelBDerivedPayload(payload) : payload;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const { __propertyControlAnalysis: _protectedAudit, ...accountingPayload } = source;
  return accountingPayload;
};
"""
text = replace_once(text, old_fp, new_fp, 'fingerprint excludes audit metadata')
cycles.write_text(text, encoding='utf-8')

print('Applied accounting evidence audit backend protection.')
