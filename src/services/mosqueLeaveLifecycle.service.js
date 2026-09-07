import { prisma } from '../prisma.js';

const archiveLeaves = async ({ client, rows, actor = null, reason, source }) => {
  if (!rows.length) return { count: 0, leaveNumbers: [] };

  const ids = rows.map((row) => row.id);
  await client.mosqueLeave.updateMany({
    where: { id: { in: ids } },
    data: { status: 'archived' },
  });

  for (const row of rows) {
    await client.auditLog.create({
      data: {
        userId: actor?.id || null,
        username: actor?.username || (source === 'startup_reconciliation' ? 'system' : null),
        userEmail: actor?.email || null,
        userRole: actor?.role ? String(actor.role) : null,
        action: 'archive',
        module: 'mosques',
        entity: 'leave_workflow',
        entityId: row.id,
        entityLabel: row.leaveNumber,
        status: 'success',
        description: reason,
        details: {
          fromStatus: row.status,
          toStatus: 'archived',
          note: reason,
          automatic: true,
          source,
        },
        previousData: {
          status: row.status,
          personnelId: row.personnelId || null,
          applicantUserId: row.applicantUserId || null,
          siteId: row.siteId,
        },
        newData: {
          status: 'archived',
          personnelId: row.personnelId || null,
          applicantUserId: row.applicantUserId || null,
          siteId: row.siteId,
        },
        metadata: { source, automatic: true },
      },
    });
  }

  return { count: rows.length, leaveNumbers: rows.map((row) => row.leaveNumber) };
};

export const archiveMosqueLeavesForRemovedPersonnel = async ({
  client = prisma,
  personnel,
  actor = null,
  source = 'personnel_removal',
} = {}) => {
  if (!personnel?.id && !personnel?.userId) return { count: 0, leaveNumbers: [] };

  const links = [];
  if (personnel?.id) links.push({ personnelId: personnel.id });
  if (personnel?.userId) links.push({ applicantUserId: personnel.userId });

  const rows = await client.mosqueLeave.findMany({
    where: {
      status: { not: 'archived' },
      OR: links,
    },
    select: {
      id: true,
      leaveNumber: true,
      status: true,
      siteId: true,
      personnelId: true,
      applicantUserId: true,
    },
  });

  return archiveLeaves({
    client,
    rows,
    actor,
    source,
    reason: 'أرشفة تلقائية لطلب الإجازة/الاعتذار بعد إزالة مقدم الطلب من منسوبي المسجد أو المصلى.',
  });
};

// يعالج السجلات القديمة التي بقيت في لوحة الإجازات بعد حذف الإمام/المؤذن قبل تطبيق الآلية الجديدة.
// لا يُؤرشف أي طلب إذا كان صاحبه ما زال منسوبًا نشطًا في نفس المسجد/المصلى.
export const archiveOrphanedMosqueLeaves = async () => {
  const candidates = await prisma.mosqueLeave.findMany({
    where: {
      status: { not: 'archived' },
      applicantUserId: { not: null },
    },
    select: {
      id: true,
      leaveNumber: true,
      status: true,
      siteId: true,
      personnelId: true,
      applicantUserId: true,
    },
  });

  if (!candidates.length) return { count: 0, leaveNumbers: [] };

  const userIds = [...new Set(candidates.map((row) => row.applicantUserId).filter(Boolean))];
  const activePersonnel = userIds.length
    ? await prisma.mosquePersonnel.findMany({
        where: { userId: { in: userIds }, active: true },
        select: { userId: true, siteId: true },
      })
    : [];

  const activeKeys = new Set(
    activePersonnel
      .filter((row) => row.userId)
      .map((row) => `${row.userId}:${row.siteId}`)
  );

  const orphaned = candidates.filter(
    (row) => row.applicantUserId && !activeKeys.has(`${row.applicantUserId}:${row.siteId}`)
  );

  if (!orphaned.length) return { count: 0, leaveNumbers: [] };

  const result = await prisma.$transaction((tx) =>
    archiveLeaves({
      client: tx,
      rows: orphaned,
      source: 'startup_reconciliation',
      reason: 'أرشفة تلقائية لسجل إجازة/اعتذار معلّق لأن مقدم الطلب لم يعد منسوبًا نشطًا في الموقع.',
    })
  );

  console.log(`Archived ${result.count} orphaned mosque leave request(s): ${result.leaveNumbers.join(', ')}`);
  return result;
};
