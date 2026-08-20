export const MODEL_B_VERSION = 'النسخة الثالثة';
export const MODEL_B_ISSUE_DATE = '2026-06-24';
export const MODEL_B_SHEET_NAME = 'سجل الأصول';
export const MODEL_B_PROCEDURES = ['إضافة', 'نقل', 'بيع', 'تحديث', 'إتلاف'];
export const MODEL_B_VALUATION_METHODS = ['التكلفة التاريخية', 'التكلفة المفترضة'];

export const MODEL_B_REQUIRED_COLUMNS = [
  'A','B','E','H','K','N','U','AA','AB','AC','AD','AE','AF','AG','AH','AI','AJ','AQ','AR','AS','AU','AV',
];

export const MODEL_B_DISPOSAL_COLUMNS = ['AY','AZ','BA','BB'];

export const MODEL_B_CORE_COLUMNS = {
  entityName: 'A',
  entityCode: 'B',
  procedure: 'C',
  level1Code: 'D',
  level1Ar: 'E',
  level1En: 'F',
  level2Code: 'G',
  level2Ar: 'H',
  level2En: 'I',
  level3Code: 'J',
  level3Ar: 'K',
  level3En: 'L',
  accountingGroupCode: 'M',
  accountingGroup: 'N',
  accountingGroupEn: 'O',
  accountingAssetCode: 'P',
  linkedAsset: 'X',
  mofAssetNumber: 'Y',
  entityAssetNumber: 'Z',
  assetDescription: 'AA',
  cardNumber: 'AB',
  unitOfMeasure: 'AC',
  quantity: 'AD',
  manufacturer: 'AE',
  serviceDate: 'AF',
  valuationMethod: 'AG',
  cost: 'AH',
  depreciationAmount: 'AI',
  accumulatedDepreciation: 'AJ',
  impairmentExpense: 'AK',
  accumulatedImpairment: 'AL',
  residualValue: 'AM',
  netBookValue: 'AN',
  usefulLife: 'AO',
  remainingUsefulLife: 'AP',
  country: 'AQ',
  region: 'AR',
  city: 'AS',
  coordinates: 'AT',
  nationalAddress: 'AU',
  buildingNumber: 'AV',
  floor: 'AW',
  room: 'AX',
  disposalDate: 'AY',
  disposalBookValue: 'AZ',
  disposalValue: 'BA',
  profitLoss: 'BB',
};

export const hasModelBValue = (value) => value !== null && value !== undefined && String(value).trim().length > 0;

const numberOrNull = (value) => {
  if (!hasModelBValue(value)) return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

export const calculateModelBDerivedPayload = (payload = {}) => {
  const next = { ...payload };
  const cost = numberOrNull(next.AH);
  const residual = numberOrNull(next.AM) ?? 0;
  const usefulLife = numberOrNull(next.AO);
  const remainingLife = numberOrNull(next.AP);
  const accumulatedImpairment = numberOrNull(next.AL) ?? 0;
  const method = String(next.AG || '').trim();

  if (method === 'التكلفة التاريخية' && cost !== null && usefulLife && usefulLife > 0) {
    const depreciable = Math.max(0, cost - residual);
    const annual = depreciable / usefulLife;
    next.AI = roundMoney(annual);
    if (remainingLife !== null) {
      const usedLife = Math.max(0, Math.min(usefulLife, usefulLife - remainingLife));
      next.AJ = roundMoney(Math.min(depreciable, annual * usedLife));
    }
  }

  const accumulatedDepreciation = numberOrNull(next.AJ) ?? 0;
  if (cost !== null) next.AN = roundMoney(cost - accumulatedDepreciation - accumulatedImpairment);

  const disposalValue = numberOrNull(next.BA);
  const disposalBookValue = numberOrNull(next.AZ);
  if (disposalValue !== null && disposalBookValue !== null) next.BB = roundMoney(disposalValue - disposalBookValue);

  return next;
};

export const validateModelBPayload = (payload = {}) => {
  const derived = calculateModelBDerivedPayload(payload);
  const missingMandatory = MODEL_B_REQUIRED_COLUMNS.filter((column) => !hasModelBValue(derived[column]));
  const procedure = String(derived.C || '').trim();
  const missingConditional = ['بيع', 'إتلاف'].includes(procedure)
    ? MODEL_B_DISPOSAL_COLUMNS.filter((column) => !hasModelBValue(derived[column]))
    : [];
  return {
    payload: derived,
    missingMandatory,
    missingConditional,
    complete: missingMandatory.length === 0 && missingConditional.length === 0,
    completion: Math.round(((MODEL_B_REQUIRED_COLUMNS.length - missingMandatory.length) / MODEL_B_REQUIRED_COLUMNS.length) * 100),
  };
};
