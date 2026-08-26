from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

# 1) Prisma model
schema_path = Path('prisma/schema.prisma')
schema = schema_path.read_text(encoding='utf-8')
schema = replace_once(
    schema,
    '  siteType         String   @default("mosque")\n  city             String?\n',
    '  siteType         String   @default("mosque")\n  prayerRoomGender String?\n  city             String?\n',
    'MosqueSite.prayerRoomGender',
)
schema_path.write_text(schema, encoding='utf-8')

# 2) Mosque routes/schema + public projections
routes_path = Path('src/routes/mosques.routes.js')
routes = routes_path.read_text(encoding='utf-8')
routes = replace_once(
    routes,
    "  siteType: z.enum(['mosque', 'jami', 'prayer_room']).default('mosque'),\n  city: z.string().trim().optional().nullable(),\n",
    "  siteType: z.enum(['mosque', 'jami', 'prayer_room']).default('mosque'),\n  prayerRoomGender: z.enum(['men', 'women']).optional().nullable(),\n  city: z.string().trim().optional().nullable(),\n",
    'siteSchema.prayerRoomGender',
)
routes = routes.replace(
    'publicToken: true, name: true, siteType: true, city: true, district: true,',
    'publicToken: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true,'
)
routes = routes.replace(
    'id: true, publicToken: true, name: true, siteType: true, city: true, district: true,',
    'id: true, publicToken: true, name: true, siteType: true, prayerRoomGender: true, city: true, district: true,'
)
if 'prayerRoomGender: z.enum' not in routes:
    raise SystemExit('route validation was not updated')
routes_path.write_text(routes, encoding='utf-8')

# 3) Official inventory: tag known male/female prayer rooms and backfill existing records
service_path = Path('src/services/mosqueSites.service.js')
service = service_path.read_text(encoding='utf-8')
service = replace_once(
    service,
    "        name: `مصلى ${item.label} - ${genderLabel}${sequence}`,\n        siteType: 'prayer_room',\n        city: item.city,\n",
    "        name: `مصلى ${item.label} - ${genderLabel}${sequence}`,\n        siteType: 'prayer_room',\n        prayerRoomGender: genderLabel === 'نساء' ? 'women' : 'men',\n        city: item.city,\n",
    'generated prayer-room gender',
)
old_ensure = """export async function ensureOfficialMosqueSites() {
  const names = OFFICIAL_MOSQUE_SITES.map((site) => site.name);
  const existing = await prisma.mosqueSite.findMany({
    where: { name: { in: names } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((site) => site.name));
  const missing = OFFICIAL_MOSQUE_SITES.filter((site) => !existingNames.has(site.name));

  if (!missing.length) return { created: 0, total: OFFICIAL_MOSQUE_SITES.length };

  await prisma.$transaction(
    missing.map((site) => prisma.mosqueSite.create({ data: site }))
  );

  console.log(`Official mosque/prayer-room sites ensured: ${missing.length} created, ${OFFICIAL_MOSQUE_SITES.length} total.`);
  return { created: missing.length, total: OFFICIAL_MOSQUE_SITES.length };
}
"""
new_ensure = """export async function ensureOfficialMosqueSites() {
  const names = OFFICIAL_MOSQUE_SITES.map((site) => site.name);
  const existing = await prisma.mosqueSite.findMany({
    where: { name: { in: names } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((site) => site.name));
  const missing = OFFICIAL_MOSQUE_SITES.filter((site) => !existingNames.has(site.name));

  if (missing.length) {
    await prisma.$transaction(
      missing.map((site) => prisma.mosqueSite.create({ data: site }))
    );
  }

  const genderBackfills = OFFICIAL_MOSQUE_SITES.filter((site) => site.siteType === 'prayer_room' && site.prayerRoomGender);
  if (genderBackfills.length) {
    await prisma.$transaction(
      genderBackfills.map((site) => prisma.mosqueSite.updateMany({
        where: { name: site.name, prayerRoomGender: null },
        data: { prayerRoomGender: site.prayerRoomGender },
      }))
    );
  }

  console.log(`Official mosque/prayer-room sites ensured: ${missing.length} created, ${genderBackfills.length} gender records checked, ${OFFICIAL_MOSQUE_SITES.length} total.`);
  return { created: missing.length, genderChecked: genderBackfills.length, total: OFFICIAL_MOSQUE_SITES.length };
}
"""
service = replace_once(service, old_ensure, new_ensure, 'ensureOfficialMosqueSites')
service_path.write_text(service, encoding='utf-8')

print('Prayer-room gender backend patch applied successfully.')
