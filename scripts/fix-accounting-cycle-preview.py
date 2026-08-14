from pathlib import Path

p = Path('src/routes/accounting-cycles.routes.js')
s = p.read_text()
old = """      if (seen.has(stableKey) || targetKeys.has(stableKey)) {
        duplicateIndexes.push(index);
        return;
      }
      seen.add(stableKey);
      freshIndexes.push(index);
      const previous = baseByKey.get(stableKey);
      if (!previous) newIndexes.push(index);
      else if (previous.sourceFingerprint === fingerprint) unchangedIndexes.push(index);
      else modifiedIndexes.push(index);"""
new = """      if (seen.has(stableKey)) {
        duplicateIndexes.push(index);
        return;
      }
      seen.add(stableKey);

      // Change classification describes the complete uploaded version and must
      // remain stable even after one or more batches have already been saved.
      const previous = baseByKey.get(stableKey);
      if (!previous) newIndexes.push(index);
      else if (previous.sourceFingerprint === fingerprint) unchangedIndexes.push(index);
      else modifiedIndexes.push(index);

      if (targetKeys.has(stableKey)) {
        duplicateIndexes.push(index);
        return;
      }
      freshIndexes.push(index);"""
if old not in s:
    raise SystemExit('preview classification block not found')
p.write_text(s.replace(old, new, 1))
