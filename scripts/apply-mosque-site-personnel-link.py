from pathlib import Path
import re

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')

if 'enrichMosqueSitePersonnelNames' not in text:
    anchor = "const MOSQUE_MODULE_ROLE_LABELS = { head: 'رئيس الوحدة', supervisor: 'مشرف الوحدة', personnel: 'منسوب المسجد أو المصلى', university_member: 'منسوب الجامعة', viewer: 'منسوب الجامعة' };\n"
    if anchor not in text:
        raise SystemExit('personnel label anchor not found')
    helper = anchor + r'''

// مصدر أسماء الإمام والمؤذن والخطيب في بطاقة المسجد هو سجل منسوبي المساجد نفسه.
// لا نعتمد على الحقول النصية اليدوية داخل MosqueSite حتى لا تتقادم الأسماء عند النقل أو التعديل.
const enrichMosqueSitePersonnelNames = async (sites) => {
  const inputWasArray = Array.isArray(sites);
  const list = inputWasArray ? sites : (sites ? [sites] : []);
  if (!list.length) return inputWasArray ? [] : null;

  const siteIds = [...new Set(list.map((site) => site?.id).filter(Boolean))];
  const personnelRows = siteIds.length
    ? await prisma.mosquePersonnel.findMany({
        where: {
          siteId: { in: siteIds },
          active: true,
          role: { in: ['imam', 'muezzin', 'khateeb'] },
        },
        select: { siteId: true, name: true, role: true },
        orderBy: [{ siteId: 'asc' }, { role: 'asc' }, { name: 'asc' }],
      })
    : [];

  const grouped = new Map();
  for (const row of personnelRows) {
    if (!grouped.has(row.siteId)) grouped.set(row.siteId, { imam: [], muezzin: [], khateeb: [] });
    const bucket = grouped.get(row.siteId);
    if (bucket?.[row.role] && row.name?.trim()) bucket[row.role].push(row.name.trim());
  }

  const linked = list.map((site) => {
    const roles = grouped.get(site.id) || { imam: [], muezzin: [], khateeb: [] };
    return {
      ...site,
      imamName: roles.imam.length ? roles.imam.join('، ') : null,
      muezzinName: roles.muezzin.length ? roles.muezzin.join('، ') : null,
      khateebName: roles.khateeb.length ? roles.khateeb.join('، ') : null,
    };
  });

  return inputWasArray ? linked : linked[0];
};
'''
    text = text.replace(anchor, helper, 1)

route_pattern = re.compile(r"router\.get\('/sites', async \(req, res, next\) => \{.*?\n\}\);\n\nrouter\.post\('/sites'", re.S)
match = route_pattern.search(text)
if not match:
    raise SystemExit('sites route block not found')

new_route = r'''router.get('/sites', async (req, res, next) => {
  try {
    const context = await getModuleRole(req);
    if (context.role === 'head') {
      const sites = await prisma.mosqueSite.findMany({
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      });
      return res.json(await enrichMosqueSitePersonnelNames(sites));
    }
    if (context.role === 'supervisor') {
      const sites = await prisma.mosqueSite.findMany({
        where: { supervisorUserId: req.authUser.id },
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      });
      return res.json(await enrichMosqueSitePersonnelNames(sites));
    }
    if (context.role === 'personnel') {
      if (!context.siteId) return res.json([]);
      const site = await prisma.mosqueSite.findUnique({
        where: { id: context.siteId },
        include: { _count: { select: { requests: true, tickets: true, personnel: true } } },
      });
      const linkedSite = site ? await enrichMosqueSitePersonnelNames(site) : null;
      return res.json(linkedSite ? [linkedSite] : []);
    }
    return res.json(await prisma.mosqueSite.findMany({
      where: { status: { not: 'temporarily_closed' } },
      select: {
        id: true, publicToken: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true,
        campusLocation: true, area: true, capacity: true, latitude: true, longitude: true,
        mapUrl: true, status: true,
      },
      orderBy: { name: 'asc' },
    }));
  } catch (error) { next(error); }
});

router.post('/sites' '''
text = text[:match.start()] + new_route + text[match.end():]

path.write_text(text, encoding='utf-8')
print('Mosque site personnel linking applied.')
