export const ACCOUNTING_BASELINE_SOURCE_SHEETS = Object.freeze({
  land: 'أ - الأراضي - Land',
  building: 'ب- Building - المباني',
});

export const normalizeAccountingSheetName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

export const baselineSourceSheetFor = (recordType) =>
  recordType === 'land'
    ? ACCOUNTING_BASELINE_SOURCE_SHEETS.land
    : recordType === 'building'
      ? ACCOUNTING_BASELINE_SOURCE_SHEETS.building
      : null;

export const isAccountingBaselineSource = (recordType, sourceSheet) => {
  const expected = baselineSourceSheetFor(recordType);
  return Boolean(
    expected
      && normalizeAccountingSheetName(sourceSheet) === normalizeAccountingSheetName(expected),
  );
};
