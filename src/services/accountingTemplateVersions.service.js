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

export const createCycleTemplateSnapshot = async (cycleId, template = null) => {
  const source = template || await getCurrentAccountingTemplateWithVersion();
  if (!source) return null;
  return prisma.accountingCycleTemplateSnapshot.upsert({
    where: { cycleId },
    update: {},
    create: {
      cycleId,
      templateId: source.id,
      fileName: source.fileName,
      versionNumber: Number(source.versionNumber || 1),
      driveFileId: source.driveFileId,
      attachedAt: new Date(),
    },
  });
};

export const getCycleTemplateSnapshot = async (cycle, { attachForOpenCycle = false } = {}) => {
  let snapshot = await prisma.accountingCycleTemplateSnapshot.findUnique({ where: { cycleId: cycle.id } });
  if (!snapshot && attachForOpenCycle && ['draft', 'under_review'].includes(cycle.status)) {
    snapshot = await createCycleTemplateSnapshot(cycle.id);
  }
  return snapshot;
};

export const attachCurrentAccountingTemplateToOpenCycles = async (cycles = null) => {
  const openCycles = cycles || await prisma.accountingTransformationCycle.findMany({
    where: { status: { in: ['draft', 'under_review'] } },
    select: { id: true, status: true },
  });
  if (!openCycles.length) return 0;
  const current = await getCurrentAccountingTemplateWithVersion();
  if (!current) return 0;
  const existing = await prisma.accountingCycleTemplateSnapshot.findMany({
    where: { cycleId: { in: openCycles.map((cycle) => cycle.id) } },
    select: { cycleId: true },
  });
  const existingIds = new Set(existing.map((item) => item.cycleId));
  let attached = 0;
  for (const cycle of openCycles) {
    if (existingIds.has(cycle.id)) continue;
    await createCycleTemplateSnapshot(cycle.id, current);
    attached += 1;
  }
  return attached;
};

export const decorateCyclesWithTemplateSnapshot = async (cycles) => {
  if (!cycles.length) return cycles;
  const snapshots = await prisma.accountingCycleTemplateSnapshot.findMany({
    where: { cycleId: { in: cycles.map((cycle) => cycle.id) } },
  });
  const byCycle = new Map(snapshots.map((item) => [item.cycleId, item]));
  return cycles.map((cycle) => ({ ...cycle, officialTemplate: byCycle.get(cycle.id) || null }));
};
