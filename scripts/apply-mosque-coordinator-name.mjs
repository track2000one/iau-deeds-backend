import fs from 'node:fs';

const replaceOnce = (source, before, after, label) => {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return source.replace(before, after);
};

const schemaFile = 'prisma/schema.prisma';
let schema = fs.readFileSync(schemaFile, 'utf8');
schema = replaceOnce(
  schema,
  "  contactPhone     String?\n",
  "  coordinatorName  String?\n  contactPhone     String?\n",
  'MosqueSite coordinatorName schema',
);
fs.writeFileSync(schemaFile, schema);

const routeFile = 'src/routes/mosques.routes.js';
let routes = fs.readFileSync(routeFile, 'utf8');
routes = replaceOnce(
  routes,
  "  khateebName: z.string().trim().optional().nullable(),\n  contactPhone: z.string().trim().optional().nullable(),\n",
  "  khateebName: z.string().trim().optional().nullable(),\n  coordinatorName: z.string().trim().optional().nullable(),\n  contactPhone: z.string().trim().optional().nullable(),\n",
  'siteSchema coordinatorName',
);
fs.writeFileSync(routeFile, routes);

const serviceFile = 'src/services/mosqueSites.service.js';
let service = fs.readFileSync(serviceFile, 'utf8');
service = replaceOnce(
  service,
  "        status: 'active',\n        contactPhone: item.coordinator?.mobile || null,\n",
  "        status: 'active',\n        coordinatorName: item.coordinator?.name || null,\n        contactPhone: item.coordinator?.mobile || null,\n",
  'official prayer room coordinatorName',
);

service = replaceOnce(
  service,
  "  if (genderBackfills.length) {\n    await prisma.$transaction(\n      genderBackfills.map((site) => prisma.mosqueSite.updateMany({\n        where: { name: site.name, prayerRoomGender: null },\n        data: { prayerRoomGender: site.prayerRoomGender },\n      }))\n    );\n  }\n\n  console.log(`Official mosque/prayer-room sites ensured: ${missing.length} created, ${genderBackfills.length} gender records checked, ${OFFICIAL_MOSQUE_SITES.length} total.`);\n  return { created: missing.length, genderChecked: genderBackfills.length, total: OFFICIAL_MOSQUE_SITES.length };\n",
  "  if (genderBackfills.length) {\n    await prisma.$transaction(\n      genderBackfills.map((site) => prisma.mosqueSite.updateMany({\n        where: { name: site.name, prayerRoomGender: null },\n        data: { prayerRoomGender: site.prayerRoomGender },\n      }))\n    );\n  }\n\n  const coordinatorBackfills = OFFICIAL_MOSQUE_SITES.filter((site) => site.coordinatorName);\n  if (coordinatorBackfills.length) {\n    await prisma.$transaction(\n      coordinatorBackfills.map((site) => prisma.mosqueSite.updateMany({\n        where: { name: site.name, coordinatorName: null },\n        data: { coordinatorName: site.coordinatorName },\n      }))\n    );\n  }\n\n  console.log(`Official mosque/prayer-room sites ensured: ${missing.length} created, ${genderBackfills.length} gender records checked, ${coordinatorBackfills.length} coordinator records checked, ${OFFICIAL_MOSQUE_SITES.length} total.`);\n  return { created: missing.length, genderChecked: genderBackfills.length, coordinatorChecked: coordinatorBackfills.length, total: OFFICIAL_MOSQUE_SITES.length };\n",
  'coordinator backfill',
);
fs.writeFileSync(serviceFile, service);
console.log('Backend coordinator name patch applied successfully.');
