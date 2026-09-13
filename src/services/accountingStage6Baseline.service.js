import { google } from 'googleapis';
import { prisma } from '../prisma.js';
import {
  buildAccountingSnapshotData,
  createAccountingFingerprint,
  createAccountingStableKey,
} from './accountingCycles.service.js';
import { getCurrentAccountingTemplateWithVersion } from './accountingTemplateVersions.service.js';

export const ACCOUNTING_STAGE6_SOURCE = Object.freeze({
  snapshotId: 'iau-consultant-stage6-2026-09-13',
  originalFileName: 'جامعة الإمام عبدالرحمن بن فيصل - معالجة ملاحظات الاستشاري - المرحلة 6.xlsx',
  originalFileSha256: '0830bb12a2b50885347dfc0ec29c2f4aa423b64f6804b40b9c36aef5b3862891',
  rawDriveFileId: '1c7vepXmlNYsXGqlN5mSa3sfvB8UBxuQh',
  spreadsheetId: '1zn53LDTfMsEr11G-AajwtqVu5kXGI0z_YnnFt0aQivY',
  landSheet: 'أ - الأراضي - Land',
  buildingSheet: ' ب- Building - المباني',
  landRange: "'أ - الأراضي - Land'!A8:BQ23",
  buildingRange: "' ب- Building - المباني'!A8:CM632",
  expected: Object.freeze({
    land: 16,
    building: 625,
    total: 641,
    deedBearingLand: 11,
  }),
});

let runtimeStatus = {
  state: 'pending',
  snapshotId: ACCOUNTING_STAGE6_SOURCE.snapshotId,
  expected: ACCOUNTING_STAGE6_SOURCE.expected,
  appliedAt: null,
  currentRecords: null,
  message: 'بانتظار مزامنة ملف المرحلة السادسة.',
};

const getOAuthClient = () => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth credentials are incomplete; cannot read the Stage 6 spreadsheet.');
  }
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
};

const columnName = (index) => {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
};

const rowToPayload = (row = []) => {
  const payload = {};
  row.forEach((value, index) => {
    if (value === null || value === undefined || value === '') return;
    payload[columnName(index)] = typeof value === 'string' ? value.trim() : value;
  });
  return payload;
};

const hasRowData = (payload = {}) => String(payload.B ?? '').trim() || String(payload.G ?? '').trim();

const isAvailableIdentityValue = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return Boolean(normalized)
    && !['not available', 'not applicable', 'n/a', 'na', 'غير متوفر', 'غير متاح', 'لا يوجد', '-', '—'].includes(normalized);
};

export const stage6MatricesToItems = ({ landValues = [], buildingValues = [] } = {}) => {
  const land = landValues
    .map((row, index) => ({
      recordType: 'land',
      sourceSheet: ACCOUNTING_STAGE6_SOURCE.landSheet,
      sourceRow: index + 8,
      payload: rowToPayload(row),
    }))
    .filter((item) => hasRowData(item.payload));

  const building = buildingValues
    .map((row, index) => ({
      recordType: 'building',
      sourceSheet: ACCOUNTING_STAGE6_SOURCE.buildingSheet,
      sourceRow: index + 8,
      payload: rowToPayload(row),
    }))
    .filter((item) => hasRowData(item.payload));

  return [...land, ...building];
};

export const validateStage6Items = (items = []) => {
  const land = items.filter((item) => item.recordType === 'land');
  const building = items.filter((item) => item.recordType === 'building');
  const deedBearingLand = land.filter((item) =>
    isAvailableIdentityValue(item.payload?.AJ) && isAvailableIdentityValue(item.payload?.AG));

  const actual = {
    land: land.length,
    building: building.length,
    total: items.length,
    deedBearingLand: deedBearingLand.length,
  };

  const expected = ACCOUNTING_STAGE6_SOURCE.expected;
  const valid = Object.entries(expected).every(([key, value]) => Number(actual[key]) === Number(value));
  if (!valid) {
    throw new Error(
      `Stage 6 spreadsheet validation failed. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}. No accounting data was replaced.`,
    );
  }
  return actual;
};

const readStage6Spreadsheet = async () => {
  const sheets = google.sheets({ version: 'v4', auth: getOAuthClient() });
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ACCOUNTING_STAGE6_SOURCE.spreadsheetId,
    ranges: [ACCOUNTING_STAGE6_SOURCE.landRange, ACCOUNTING_STAGE6_SOURCE.buildingRange],
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const [landRange, buildingRange] = response.data.valueRanges || [];
  const items = stage6MatricesToItems({
    landValues: landRange?.values || [],
    buildingValues: buildingRange?.values || [],
  });
  const counts = validateStage6Items(items);
  return { items, counts };
};

const getExistingApplication = (client = prisma) => client.auditLog.findFirst({
  where: {
    module: 'accounting_transformation',
    action: 'apply_accounting_stage6_baseline',
    entityId: ACCOUNTING_STAGE6_SOURCE.originalFileSha256,
    status: 'success',
  },
  orderBy: { createdAt: 'desc' },
});

export const getAccountingStage6RuntimeStatus = () => ({ ...runtimeStatus });

export const applyAccountingStage6Baseline = async ({ force = false, client = prisma } = {}) => {
  const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
  const isProduction = process.env.NODE_ENV === 'production';
  const autoApplyEnabled = process.env.ACCOUNTING_STAGE6_AUTO_APPLY !== 'false';

  if (!force && (!autoApplyEnabled || (!isRailway && !isProduction))) {
    runtimeStatus = {
      ...runtimeStatus,
      state: 'skipped',
      message: 'تم تجاوز المزامنة التلقائية خارج بيئة الإنتاج.',
    };
    return runtimeStatus;
  }

  const existing = await getExistingApplication(client);
  if (existing && !force) {
    const currentRecords = await client.accountingTransformationRecord.count();
    runtimeStatus = {
      ...runtimeStatus,
      state: 'already_applied',
      appliedAt: existing.createdAt?.toISOString?.() || String(existing.createdAt || ''),
      currentRecords,
      message: 'ملف المرحلة السادسة سبق تطبيقه على قاعدة البيانات.',
    };
    return runtimeStatus;
  }

  runtimeStatus = {
    ...runtimeStatus,
    state: 'reading_source',
    message: 'جاري قراءة آخر ملف Excel المراجع من Google Sheets.',
  };

  const { items, counts } = await readStage6Spreadsheet();
  const currentTemplate = await getCurrentAccountingTemplateWithVersion().catch(() => null);
  const now = new Date();
  const year = now.getFullYear();

  const result = await client.$transaction(async (tx) => {
    const previous = {
      cycles: await tx.accountingTransformationCycle.count(),
      records: await tx.accountingTransformationRecord.count(),
      cycleTemplateSnapshots: await tx.accountingCycleTemplateSnapshot.count(),
    };

    await tx.accountingCycleTemplateSnapshot.deleteMany({});
    await tx.accountingTransformationRecord.deleteMany({});
    await tx.accountingTransformationCycle.deleteMany({});

    const cycle = await tx.accountingTransformationCycle.create({
      data: {
        cycleNumber: 1,
        name: 'البيانات الأساسية المعتمدة - ملف المرحلة السادسة',
        description: `تمت إعادة تأسيس سجل الأصول ومتطلبات التحول من ${ACCOUNTING_STAGE6_SOURCE.originalFileName} بعد معالجة ملاحظات الاستشاري.`,
        status: 'approved',
        isCurrent: true,
        basedOnCycleId: null,
        sourceFileName: ACCOUNTING_STAGE6_SOURCE.originalFileName,
        importedAt: now,
        importedBy: 'system:stage6-baseline',
        reviewedAt: now,
        reviewedBy: 'system:stage6-baseline',
        approvedAt: now,
        approvedBy: 'system:stage6-baseline',
        createdBy: 'system:stage6-baseline',
      },
    });

    const rows = items.map((item, index) => {
      const payload = item.payload || {};
      const stableKey = createAccountingStableKey(item.recordType, payload);
      const sourceFingerprint = createAccountingFingerprint(item.recordType, payload);
      const snapshot = buildAccountingSnapshotData(
        {
          recordType: item.recordType,
          committeeStatus: 'approved',
          payload,
          attachments: [],
          notes: null,
        },
        { email: 'system:stage6-baseline' },
        {
          cycleId: cycle.id,
          stableKey,
          sourceFingerprint,
          changeType: 'baseline',
          previousRecordId: null,
        },
      );
      return {
        ...snapshot,
        recordNumber: `ACT-${year}-${String(index + 1).padStart(6, '0')}`,
        committeeStatus: 'approved',
        changeType: 'baseline',
        createdBy: 'system:stage6-baseline',
        updatedBy: 'system:stage6-baseline',
      };
    });

    for (let index = 0; index < rows.length; index += 250) {
      await tx.accountingTransformationRecord.createMany({ data: rows.slice(index, index + 250) });
    }

    if (currentTemplate) {
      await tx.accountingCycleTemplateSnapshot.create({
        data: {
          cycleId: cycle.id,
          templateId: currentTemplate.id,
          fileName: currentTemplate.fileName,
          versionNumber: Number(currentTemplate.versionNumber || 1),
          driveFileId: currentTemplate.driveFileId,
          attachedAt: now,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        username: 'system',
        userRole: 'system',
        action: 'apply_accounting_stage6_baseline',
        module: 'accounting_transformation',
        entity: 'accounting_cycle',
        entityId: ACCOUNTING_STAGE6_SOURCE.originalFileSha256,
        entityLabel: cycle.name,
        status: 'success',
        description: `عكس آخر ملف Excel مراجع في المنصة: ${counts.land} أرضًا و${counts.building} مبنى، منها ${counts.deedBearingLand} أرضًا بهوية صك AJ + AG.`,
        previousData: previous,
        newData: {
          snapshotId: ACCOUNTING_STAGE6_SOURCE.snapshotId,
          spreadsheetId: ACCOUNTING_STAGE6_SOURCE.spreadsheetId,
          rawDriveFileId: ACCOUNTING_STAGE6_SOURCE.rawDriveFileId,
          originalFileName: ACCOUNTING_STAGE6_SOURCE.originalFileName,
          originalFileSha256: ACCOUNTING_STAGE6_SOURCE.originalFileSha256,
          counts,
          cycleId: cycle.id,
        },
      },
    });

    return { cycle, previous, counts };
  }, { timeout: 120000, isolationLevel: 'Serializable' });

  runtimeStatus = {
    ...runtimeStatus,
    state: 'applied',
    appliedAt: now.toISOString(),
    currentRecords: result.counts.total,
    actual: result.counts,
    message: `تم تطبيق ملف المرحلة السادسة: ${result.counts.total} سجلًا.`,
  };

  return runtimeStatus;
};
