import fs from 'node:fs';

const replaceOnce = (file, from, to, label) => {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) {
    if (text.includes(to)) return;
    throw new Error(`Patch target not found: ${label}`);
  }
  fs.writeFileSync(file, text.replace(from, to));
};

// Asset snapshots: merge only supplied values into the previous approved snapshot.
const assetService = 'src/services/assetCycles.service.js';
{
  let text = fs.readFileSync(assetService, 'utf8');
  const anchor = "const comparableSnapshot = (snapshot) => {";
  if (!text.includes('export const mergeAssetCycleSnapshots = (previous = {}, incoming = {}) =>')) {
    if (!text.includes(anchor)) throw new Error('Asset merge insertion anchor not found');
    const helper = `const hasMergeValue = (value) => {\n  if (value === null || value === undefined) return false;\n  if (typeof value === 'string') return value.trim().length > 0;\n  return true;\n};\n\nconst excelSourceKeys = (input) => {\n  const payload = input?.excelPayload;\n  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];\n  return Object.keys(payload).filter((key) => !key.startsWith('__'));\n};\n\nconst sourceHas = (keys, patterns) => keys.some((key) => patterns.some((pattern) => pattern.test(key)));\n\nexport const mergeAssetCycleSnapshots = (previous = {}, incoming = {}) => {\n  const before = normalizeAssetCycleInput(previous);\n  const merged = { ...before };\n  const sourceKeys = excelSourceKeys(incoming);\n  const fromExcel = sourceKeys.length > 0;\n  const guardedBySource = {\n    name: [/وصف الأصل/i, /asset description/i],\n    status: [/حالة استغلال/i, /asset utilization/i],\n    quantity: [/^العدد$/i, /^quantity$/i],\n    notes: [/ملاحظات/i, /^notes?$/i],\n  };\n\n  for (const field of ASSET_FIELDS) {\n    const value = incoming[field];\n    if (!hasMergeValue(value)) continue;\n    if (fromExcel && guardedBySource[field] && !sourceHas(sourceKeys, guardedBySource[field])) continue;\n    if (field === 'purchaseDateType' && !hasMergeValue(incoming.purchaseDate)) continue;\n    if (field === 'serviceDateType' && !hasMergeValue(incoming.serviceDate)) continue;\n    if (field === 'lastInventoryDateType' && !hasMergeValue(incoming.lastInventoryDate)) continue;\n    merged[field] = value;\n  }\n\n  if (incoming.excelPayload && typeof incoming.excelPayload === 'object' && !Array.isArray(incoming.excelPayload)) {\n    merged.excelPayload = { ...(before.excelPayload || {}), ...incoming.excelPayload };\n  }\n\n  const clearFields = Array.isArray(incoming.__clearFields) ? incoming.__clearFields : [];\n  for (const field of clearFields) {\n    if (ASSET_FIELDS.includes(field)) merged[field] = null;\n  }\n  return normalizeAssetCycleInput(merged);\n};\n\n`;
    text = text.replace(anchor, helper + anchor);
    fs.writeFileSync(assetService, text);
  }
}

replaceOnce(
  'src/routes/asset-cycles.routes.js',
  "  getAssetCycleComparison,\n  normalizeAssetCycleInput,",
  "  getAssetCycleComparison,\n  mergeAssetCycleSnapshots,\n  normalizeAssetCycleInput,",
  'asset route import merge helper',
);

replaceOnce(
  'src/routes/asset-cycles.routes.js',
  "      const snapshot = normalizeAssetCycleInput(row.input);\n      if (!isSnapshotValid(snapshot)) { result.invalid += 1; continue; }\n      const identity = createAssetStableKey(snapshot);\n      const fingerprint = createAssetFingerprint(snapshot);\n      if (seen.has(identity.key) || targetKeys.has(identity.key)) { result.duplicate += 1; continue; }\n      seen.add(identity.key);\n      result.fresh += 1;\n      const previous = baseByKey.get(identity.key);\n      if (!previous) result.new += 1;\n      else if (previous.sourceFingerprint === fingerprint) result.unchanged += 1;\n      else result.modified += 1;",
  "      const incomingSnapshot = normalizeAssetCycleInput(row.input);\n      const identity = createAssetStableKey(incomingSnapshot);\n      const previous = baseByKey.get(identity.key);\n      const snapshot = previous ? mergeAssetCycleSnapshots(previous.payload || {}, row.input) : incomingSnapshot;\n      if (!isSnapshotValid(snapshot)) { result.invalid += 1; continue; }\n      const fingerprint = createAssetFingerprint(snapshot);\n      if (seen.has(identity.key) || targetKeys.has(identity.key)) { result.duplicate += 1; continue; }\n      seen.add(identity.key);\n      result.fresh += 1;\n      if (!previous) result.new += 1;\n      else if (previous.sourceFingerprint === fingerprint) result.unchanged += 1;\n      else result.modified += 1;",
  'asset preview field merge',
);

replaceOnce(
  'src/routes/asset-cycles.routes.js',
  "      const snapshot = normalizeAssetCycleInput(row.input);\n      if (!isSnapshotValid(snapshot)) { invalid += 1; continue; }\n      const identity = createAssetStableKey(snapshot);\n      if (seen.has(identity.key) || targetKeys.has(identity.key)) { skipped += 1; continue; }\n      seen.add(identity.key);\n      const fingerprint = createAssetFingerprint(snapshot);\n      const previous = baseByKey.get(identity.key);\n      const changeType = !previous ? 'new' : previous.sourceFingerprint === fingerprint ? 'unchanged' : 'modified';",
  "      const incomingSnapshot = normalizeAssetCycleInput(row.input);\n      const identity = createAssetStableKey(incomingSnapshot);\n      if (seen.has(identity.key) || targetKeys.has(identity.key)) { skipped += 1; continue; }\n      const previous = baseByKey.get(identity.key);\n      const snapshot = previous ? mergeAssetCycleSnapshots(previous.payload || {}, row.input) : incomingSnapshot;\n      if (!isSnapshotValid(snapshot)) { invalid += 1; continue; }\n      seen.add(identity.key);\n      const fingerprint = createAssetFingerprint(snapshot);\n      const changeType = !previous ? 'new' : previous.sourceFingerprint === fingerprint ? 'unchanged' : 'modified';",
  'asset import field merge',
);

// Accounting snapshots: blank/missing cells do not erase approved values; explicit clear is opt-in.
const accountingRoute = 'src/routes/accounting-cycles.routes.js';
{
  let text = fs.readFileSync(accountingRoute, 'utf8');
  const anchor = "const itemIsValid = (item) => {";
  if (!text.includes('const mergeAccountingPayload = (previous = {}, incoming = {}) =>')) {
    if (!text.includes(anchor)) throw new Error('Accounting merge insertion anchor not found');
    const helper = `const mergeAccountingPayload = (previous = {}, incoming = {}) => {\n  const merged = { ...(previous || {}) };\n  const clearFields = Array.isArray(incoming?.__clearFields) ? incoming.__clearFields.map(String) : [];\n  for (const [key, value] of Object.entries(incoming || {})) {\n    if (key === '__clearFields') continue;\n    if (value === null || value === undefined) continue;\n    if (typeof value === 'string' && !value.trim()) continue;\n    merged[key] = value;\n  }\n  for (const field of clearFields) merged[field] = '';\n  return merged;\n};\n\n`;
    text = text.replace(anchor, helper + anchor);
    text = text.replace(
      "  return hasAccountingValue(payload.B) || hasAccountingValue(payload.E) || hasAccountingValue(payload.G);",
      "  return hasAccountingValue(payload.B) || hasAccountingValue(payload.D) || hasAccountingValue(payload.E) || hasAccountingValue(payload.G);"
    );
    fs.writeFileSync(accountingRoute, text);
  }
}

replaceOnce(
  accountingRoute,
  "          select: { stableKey: true, sourceFingerprint: true },",
  "          select: { stableKey: true, sourceFingerprint: true, payload: true },",
  'accounting preview select payload',
);
replaceOnce(
  accountingRoute,
  "      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});\n      const fingerprint = createAccountingFingerprint(item.recordType, item.payload || {});",
  "      const stableKey = createAccountingStableKey(item.recordType, item.payload || {});\n      const previous = baseByKey.get(stableKey);\n      const mergedPayload = previous ? mergeAccountingPayload(previous.payload || {}, item.payload || {}) : (item.payload || {});\n      const fingerprint = createAccountingFingerprint(item.recordType, mergedPayload);",
  'accounting preview field merge',
);
replaceOnce(
  accountingRoute,
  "      const previous = baseByKey.get(stableKey);\n      if (!previous) newIndexes.push(index);",
  "      if (!previous) newIndexes.push(index);",
  'accounting preview reuse previous',
);
replaceOnce(
  accountingRoute,
  "          select: { id: true, stableKey: true, sourceFingerprint: true },",
  "          select: { id: true, stableKey: true, sourceFingerprint: true, payload: true },",
  'accounting import select payload',
);
replaceOnce(
  accountingRoute,
  "      seen.add(stableKey);\n      const sourceFingerprint = createAccountingFingerprint(item.recordType, item.payload || {});\n      const previous = baseByKey.get(stableKey);\n      const changeType = !previous ? 'new' : previous.sourceFingerprint === sourceFingerprint ? 'unchanged' : 'modified';\n      const data = buildAccountingSnapshotData(item, req.authUser, {",
  "      seen.add(stableKey);\n      const previous = baseByKey.get(stableKey);\n      const mergedPayload = previous ? mergeAccountingPayload(previous.payload || {}, item.payload || {}) : (item.payload || {});\n      const sourceFingerprint = createAccountingFingerprint(item.recordType, mergedPayload);\n      const changeType = !previous ? 'new' : previous.sourceFingerprint === sourceFingerprint ? 'unchanged' : 'modified';\n      const data = buildAccountingSnapshotData({ ...item, payload: mergedPayload }, req.authUser, {",
  'accounting import field merge',
);

console.log('Field-level merge patch applied successfully.');
