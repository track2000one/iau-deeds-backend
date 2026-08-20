import { prisma } from '../prisma.js';

export const OFFICIAL_ACCOUNTING_TEMPLATE_KEY = 'official_accounting_transformation';

const parseArchivedVersion = (key = '') => {
  const match = String(key).match(/:v(\d+)$/i);
  return match ? Number(match[1]) : null;
};

export const getCurrentAccountingTemplateWithVersion = async () => {
  const [current, archived] = await Promise.all([
    prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY } }),
    prisma.assetExcelTemplate.findMany({
      where: { templateKey: { startsWith: `${OFFICIAL_ACCOUNTING_TEMPLATE_KEY}:v` } },
      select: { templateKey: true },
    }),
  ]);
  if (!current) return null;
  const highestArchived = archived.reduce((max, item) => Math.max(max, Number(parseArchivedVersion(item.templateKey) || 0)), 0);
  return { ...current, versionNumber: highestArchived + 1, isCurrent: true };
};

export const listAccountingTemplateVersions = async () => {
  const rows = await prisma.assetExcelTemplate.findMany({
    where: { OR: [
      { templateKey: OFFICIAL_ACCOUNTING_TEMPLATE_KEY },
      { templateKey: { startsWith: `${OFFICIAL_ACCOUNTING_TEMPLATE_KEY}:v` } },
    ] },
    orderBy: { createdAt: 'desc' },
  });
  const archived = rows
    .filter((item) => item.templateKey !== OFFICIAL_ACCOUNTING_TEMPLATE_KEY)
    .map((item) => ({ ...item, versionNumber: parseArchivedVersion(item.templateKey), isCurrent: false }))
    .sort((a, b) => Number(b.versionNumber || 0) - Number(a.versionNumber || 0));
  const current = rows.find((item) => item.templateKey === OFFICIAL_ACCOUNTING_TEMPLATE_KEY);
  const highestArchived = archived.reduce((max, item) => Math.max(max, Number(item.versionNumber || 0)), 0);
  return [
    ...(current ? [{ ...current, versionNumber: highestArchived + 1, isCurrent: true }] : []),
    ...archived,
  ];
};

export const archiveCurrentAccountingTemplate = async (current) => {
  if (!current) return null;
  const archived = await prisma.assetExcelTemplate.findMany({
    where: { templateKey: { startsWith: `${OFFICIAL_ACCOUNTING_TEMPLATE_KEY}:v` } },
    select: { templateKey: true },
  });
  const highestArchived = archived.reduce((max, item) => Math.max(max, Number(parseArchivedVersion(item.templateKey) || 0)), 0);
  const versionNumber = highestArchived + 1;
  return prisma.assetExcelTemplate.update({
    where: { id: current.id },
    data: {
      templateKey: `${OFFICIAL_ACCOUNTING_TEMPLATE_KEY}:v${versionNumber}`,
      title: `نموذج التحول المحاسبي الرسمي — الإصدار ${versionNumber}`,
    },
  });
};

export const accountingTemplateSnapshotData = (template) => template ? ({
  officialTemplateId: template.id,
  officialTemplateFileName: template.fileName,
  officialTemplateVersion: Number(template.versionNumber || 1),
  officialTemplateDriveFileId: template.driveFileId,
  officialTemplateAttachedAt: new Date(),
}) : ({});

export const attachCurrentAccountingTemplateToOpenCycles = async () => {
  const current = await getCurrentAccountingTemplateWithVersion();
  if (!current) return 0;
  const result = await prisma.accountingTransformationCycle.updateMany({
    where: {
      status: { in: ['draft', 'under_review'] },
      officialTemplateDriveFileId: null,
    },
    data: accountingTemplateSnapshotData(current),
  });
  return result.count;
};
