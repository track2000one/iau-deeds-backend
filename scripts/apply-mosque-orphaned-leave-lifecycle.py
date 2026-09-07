from pathlib import Path

routes_path = Path('src/routes/mosques.routes.js')
routes = routes_path.read_text(encoding='utf-8')

import_target = "import { sendMosquePersonnelActivationEmail } from '../services/email.service.js';\n"
import_replacement = import_target + "import { archiveMosqueLeavesForRemovedPersonnel } from '../services/mosqueLeaveLifecycle.service.js';\n"
if import_target not in routes:
    raise SystemExit('routes import target not found')
routes = routes.replace(import_target, import_replacement, 1)

config_old = "  leave: { model: 'mosqueLeaveRequest', numberField: 'leaveNumber', siteField: 'siteId' },"
config_new = "  leave: { model: 'mosqueLeave', numberField: 'leaveNumber', siteField: 'siteId' },"
if config_old not in routes:
    raise SystemExit('leave workflow model target not found')
routes = routes.replace(config_old, config_new, 1)

delete_old = """    await prisma.$transaction(async (tx) => {\n      await tx.mosquePersonnel.delete({ where: { id: current.id } });\n"""
delete_new = """    await prisma.$transaction(async (tx) => {\n      // إبعاد جميع معاملات الإجازة/الاعتذار الخاصة بالمنسوب من لوحة العمل قبل حذف سجل المنسوب.\n      // تبقى المعاملات محفوظة كأرشيف مع أثر تدقيقي كامل بدل الحذف الصلب.\n      await archiveMosqueLeavesForRemovedPersonnel({\n        client: tx,\n        personnel: current,\n        actor: req.authUser,\n        source: 'personnel_removal',\n      });\n      await tx.mosquePersonnel.delete({ where: { id: current.id } });\n"""
if delete_old not in routes:
    raise SystemExit('personnel delete transaction target not found')
routes = routes.replace(delete_old, delete_new, 1)
routes_path.write_text(routes, encoding='utf-8')

server_path = Path('src/server.js')
server = server_path.read_text(encoding='utf-8')
server_import_target = "import { ensureOfficialMosqueSites } from './services/mosqueSites.service.js';\n"
server_import_replacement = server_import_target + "import { archiveOrphanedMosqueLeaves } from './services/mosqueLeaveLifecycle.service.js';\n"
if server_import_target not in server:
    raise SystemExit('server import target not found')
server = server.replace(server_import_target, server_import_replacement, 1)

server_call_target = "  await ensureOfficialMosqueSites();\n"
server_call_replacement = server_call_target + "  await archiveOrphanedMosqueLeaves();\n"
if server_call_target not in server:
    raise SystemExit('server startup target not found')
server = server.replace(server_call_target, server_call_replacement, 1)
server_path.write_text(server, encoding='utf-8')

service_path = Path('src/services/mosqueLeaveLifecycle.service.js')
service_path.write_text("""import { prisma } from '../prisma.js';

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
""", encoding='utf-8')

print('Applied mosque orphaned-leave lifecycle patch')
