import fs from 'node:fs';

const replaceOnce = (source, before, after, label) => {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(before, after);
};

// Deeds: correct Hijri conversion and never trust client-created audit identity.
const deedsPath = 'src/routes/deeds.routes.js';
let deeds = fs.readFileSync(deedsPath, 'utf8');

deeds = replaceOnce(
  deeds,
  "const parseFlexibleDate = (value, type = 'gregorian', fieldName = 'التاريخ') => {",
  "const hijriParts = (date) => {\n  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {\n    year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC'\n  }).formatToParts(date);\n  const get = (partType) => Number(parts.find((part) => part.type === partType)?.value);\n  return { year: get('year'), month: get('month'), day: get('day') };\n};\n\nconst hijriToGregorian = (year, month, day) => {\n  const roughYear = year + 579;\n  const center = Date.UTC(roughYear, Math.max(0, month - 1), Math.min(day, 28), 12, 0, 0);\n  for (let offset = -420; offset <= 420; offset += 1) {\n    const candidate = new Date(center + offset * 86400000);\n    const hijri = hijriParts(candidate);\n    if (hijri.year === year && hijri.month === month && hijri.day === day) return candidate;\n  }\n  return null;\n};\n\nconst parseFlexibleDate = (value, type = 'gregorian', fieldName = 'التاريخ') => {",
  'deed Hijri converter helpers',
);

deeds = replaceOnce(
  deeds,
  "    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));",
  "    const converted = hijriToGregorian(year, month, day);\n    if (!converted) {\n      const error = new Error(`${fieldName} الهجري غير صحيح أو خارج النطاق المدعوم`);\n      error.status = 400;\n      throw error;\n    }\n    return converted;",
  'deed Hijri conversion',
);

deeds = replaceOnce(
  deeds,
  "const toDbData = (body) => {\n  const data = deedSchema.parse(body);\n  return {\n    ...data,\n    deedDate: parseFlexibleDate(data.deedDate, data.deedDateType, 'تاريخ الصك'),\n  };\n};",
  "const toDbData = (body, { createdBy } = {}) => {\n  const parsed = deedSchema.parse(body);\n  const { createdBy: _clientCreatedBy, ...data } = parsed;\n  return {\n    ...data,\n    ...(createdBy !== undefined ? { createdBy } : {}),\n    deedDate: parseFlexibleDate(data.deedDate, data.deedDateType, 'تاريخ الصك'),\n  };\n};",
  'deed trusted createdBy mapper',
);

deeds = replaceOnce(
  deeds,
  "    const deed = await prisma.deed.create({ data: toDbData(req.body) });",
  "    const deed = await prisma.deed.create({\n      data: toDbData(req.body, {\n        createdBy: req.authUser?.username || req.authUser?.email || null,\n      }),\n    });",
  'deed trusted creator',
);
fs.writeFileSync(deedsPath, deeds);

// Generic land/building records: preserve creator on updates and derive creator from auth on creates.
const recordsPath = 'src/routes/records.routes.js';
let records = fs.readFileSync(recordsPath, 'utf8');
records = records.replaceAll(",'notes','createdBy']", ",'notes']");
records = records.replaceAll("    'createdBy',\n  ],", "  ],");

records = replaceOnce(
  records,
  "const sanitizeAttachments = (attachments, entityType, entityId) => {",
  "const sanitizeAttachments = (attachments, entityType, entityId, createdBy = null) => {",
  'attachment sanitizer actor param',
);
records = replaceOnce(
  records,
  "      createdBy: attachment.createdBy || null,",
  "      createdBy,",
  'trusted attachment creator',
);
records = replaceOnce(
  records,
  "    const record = await delegate.create({\n      data: sanitizeRecordPayload(resource, req.body),\n    });",
  "    const record = await delegate.create({\n      data: {\n        ...sanitizeRecordPayload(resource, req.body),\n        createdBy: req.authUser?.username || req.authUser?.email || null,\n      },\n    });",
  'trusted record creator',
);
records = replaceOnce(
  records,
  "      entityTypes[resource],\n      record.id\n    );",
  "      entityTypes[resource],\n      record.id,\n      req.authUser?.username || req.authUser?.email || null\n    );",
  'record create attachment actor',
);
records = replaceOnce(
  records,
  "        entityTypes[resource],\n        req.params.id\n      );",
  "        entityTypes[resource],\n        req.params.id,\n        req.authUser?.username || req.authUser?.email || null\n      );",
  'record update attachment actor',
);
fs.writeFileSync(recordsPath, records);

console.log('Record integrity fixes applied.');
