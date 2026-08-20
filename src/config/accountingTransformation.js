import { MODEL_B_REQUIRED_COLUMNS, validateModelBPayload } from './fixedAssetModelB.js';

export const ACCOUNTING_PHASE_COLUMNS = {
  land: {
    census: ['B','C','E','F','G','H','I','J','K','L','M','U','V','W','AA','AB','AC','AD','AE','AF','AG','AH','AI','AJ','AK','BB'],
    inventory: ['B','C','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','AA','AB','AC','AD','AE','AF','AK','AL','BB'],
    valuation: ['B','C','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','AA','AB','AC','AD','AE','AF','AG','AH','AI','AJ','AK','AL','AM','AN','AO','AP','AQ','BB'],
  },
  building: {
    census: ['B','C','E','F','G','H','I','J','K','L','M','V','Z','AA','AB','AE','AF','AG','AH','AI','AJ','AK','AL','AM','AN','AO','AP','AQ','AR','AS','AT','AU','AV','AW','AX','BB','BE','BL'],
    inventory: ['B','C','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','Z','AA','AB','AC','AE','AF','AG','AH','AI','AJ','AK','AL','AM','AN','AO','AP','AQ','AR','AW','AX','AY','AZ','BB','BC','BD','BE','BL'],
    valuation: ['B','C','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','Z','AA','AB','AC','AE','AF','AG','AH','AI','AJ','AK','AL','AM','AN','AO','AP','AQ','AR','AS','AT','AU','AV','AW','AX','AY','AZ','BB','BC','BD','BE','BF','BH','BI','BJ','BK','BL'],
  },
  fixed_asset: {
    census: ['A','B','E','H','K','N','U','AA','AB','AC','AD','AE','AQ','AR','AS','AU','AV'],
    inventory: ['A','B','E','H','K','N','U','AA','AB','AC','AD','AE','AF','AQ','AR','AS','AU','AV'],
    valuation: MODEL_B_REQUIRED_COLUMNS,
  },
};

export const ACCOUNTING_CONDITIONAL_COLUMNS = {
  land: {
    leased: ['X','Y','Z'],
    revenue: ['BC','BD','BE','BF','BG'],
  },
  building: {
    leased: ['W','X','Y'],
    revenue: ['BM','BN','BO','BP','BQ'],
  },
  fixed_asset: {
    leased: [],
    revenue: [],
  },
};

export const ACCOUNTING_CORE_COLUMNS = {
  land: { entityName: 'B', entityCode: 'C', mofAssetNumber: 'D', entityAssetNumber: 'E', linkedAsset: 'F', assetDescription: 'G', accountingGroup: 'Q', accountingGroupCode: 'S', accountingAssetCode: 'T', region: 'AB', city: 'AC', revenueFlag: 'BB' },
  building: { entityName: 'B', entityCode: 'C', mofAssetNumber: 'D', entityAssetNumber: 'E', linkedAsset: 'F', assetDescription: 'G', accountingGroup: 'Q', accountingGroupCode: 'S', accountingAssetCode: 'T', region: 'AL', city: 'AM', revenueFlag: 'BL' },
  fixed_asset: { entityName: 'A', entityCode: 'B', mofAssetNumber: 'Y', entityAssetNumber: 'Z', linkedAsset: 'X', assetDescription: 'AA', accountingGroup: 'N', accountingGroupCode: 'M', accountingAssetCode: 'P', region: 'AR', city: 'AS', revenueFlag: null },
};

export const hasAccountingValue = (value) => {
  if (value === null || value === undefined) return false;
  return String(value).trim().length > 0;
};

const isYes = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['نعم', 'yes', 'y', 'true', '1'].includes(normalized);
};

export const inferAccountingOwnershipMode = (type, payload = {}) => {
  if (type === 'fixed_asset') return 'owned';
  const columns = type === 'building' ? ['W','X','Y'] : ['X','Y','Z'];
  return columns.some((column) => hasAccountingValue(payload[column])) ? 'leased' : 'owned';
};

export const calculateAccountingProgress = (type, payload = {}, ownershipMode = 'owned') => {
  if (type === 'fixed_asset') {
    const validation = validateModelBPayload(payload);
    const phase = (columns) => {
      if (!columns.length) return 0;
      const completed = columns.filter((column) => hasAccountingValue(validation.payload[column])).length;
      return Math.round((completed / columns.length) * 100);
    };
    const censusProgress = phase(ACCOUNTING_PHASE_COLUMNS.fixed_asset.census);
    const inventoryProgress = phase(ACCOUNTING_PHASE_COLUMNS.fixed_asset.inventory);
    const valuationProgress = phase(ACCOUNTING_PHASE_COLUMNS.fixed_asset.valuation);
    const overallProgress = Math.round((censusProgress + inventoryProgress + valuationProgress) / 3);
    return {
      censusProgress,
      inventoryProgress,
      valuationProgress,
      overallProgress,
      readinessStatus: validation.complete ? 'ready' : overallProgress >= 75 ? 'near_ready' : overallProgress >= 40 ? 'in_progress' : 'needs_data',
    };
  }

  const phaseColumns = ACCOUNTING_PHASE_COLUMNS[type] || ACCOUNTING_PHASE_COLUMNS.land;
  const conditional = ACCOUNTING_CONDITIONAL_COLUMNS[type] || ACCOUNTING_CONDITIONAL_COLUMNS.land;
  const core = ACCOUNTING_CORE_COLUMNS[type] || ACCOUNTING_CORE_COLUMNS.land;
  const extra = [
    ...(ownershipMode === 'leased' ? conditional.leased : []),
    ...(core.revenueFlag && isYes(payload[core.revenueFlag]) ? conditional.revenue : []),
  ];

  const phase = (columns) => {
    const required = Array.from(new Set([...columns, ...extra]));
    if (!required.length) return 0;
    const completed = required.filter((column) => hasAccountingValue(payload[column])).length;
    return Math.round((completed / required.length) * 100);
  };

  const censusProgress = phase(phaseColumns.census);
  const inventoryProgress = phase(phaseColumns.inventory);
  const valuationProgress = phase(phaseColumns.valuation);
  const overallProgress = Math.round((censusProgress + inventoryProgress + valuationProgress) / 3);

  return {
    censusProgress,
    inventoryProgress,
    valuationProgress,
    overallProgress,
    readinessStatus:
      valuationProgress === 100
        ? 'ready'
        : overallProgress >= 75
          ? 'near_ready'
          : overallProgress >= 40
            ? 'in_progress'
            : 'needs_data',
  };
};
