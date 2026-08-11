const fs = require('fs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Patch target not found: ${label}`);
  }
  return source.replace(before, after);
}

const path = 'src/routes/assets-fast.routes.js';
let src = fs.readFileSync(path, 'utf8');

src = replaceOnce(
  src,
  "const baseWhere = ({ search, category, status }) => ({\n  ...(category && category !== 'all' ? { category } : {}),\n  ...(status && status !== 'all' ? { status } : {}),\n  ...searchWhere(search),\n});",
  "const parseEntryDateBoundary = (value, endOfDay = false) => {\n  const raw = String(value || '').trim();\n  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(raw)) return null;\n  const time = endOfDay ? '23:59:59.999' : '00:00:00.000';\n  const date = new Date(`${raw}T${time}+03:00`);\n  return Number.isNaN(date.getTime()) ? null : date;\n};\n\nconst baseWhere = ({ search, category, status, dateFrom = '', dateTo = '' }) => {\n  const from = parseEntryDateBoundary(dateFrom, false);\n  const to = parseEntryDateBoundary(dateTo, true);\n  const createdAt = {\n    ...(from ? { gte: from } : {}),\n    ...(to ? { lte: to } : {}),\n  };\n\n  return {\n    ...(category && category !== 'all' ? { category } : {}),\n    ...(status && status !== 'all' ? { status } : {}),\n    ...(Object.keys(createdAt).length ? { createdAt } : {}),\n    ...searchWhere(search),\n  };\n};",
  'baseWhere entry date support'
);

src = replaceOnce(
  src,
  "    const status = String(req.query.status || '').trim();\n    const records = await prisma.asset.findMany({\n      where: baseWhere({ search, category, status }),",
  "    const status = String(req.query.status || '').trim();\n    const dateFrom = String(req.query.dateFrom || '').trim();\n    const dateTo = String(req.query.dateTo || '').trim();\n    const records = await prisma.asset.findMany({\n      where: baseWhere({ search, category, status, dateFrom, dateTo }),",
  'group route entry date filters'
);

src = replaceOnce(
  src,
  "    const status = String(req.query.status || '').trim();\n    const groupKey = String(req.query.group || '').trim();\n    const page = Math.max(1, Number(req.query.page) || 1);",
  "    const status = String(req.query.status || '').trim();\n    const groupKey = String(req.query.group || '').trim();\n    const dateFrom = String(req.query.dateFrom || '').trim();\n    const dateTo = String(req.query.dateTo || '').trim();\n    const page = Math.max(1, Number(req.query.page) || 1);",
  'report route entry date query params'
);

src = replaceOnce(
  src,
  "    const initialWhere = baseWhere({ search, category, status });",
  "    const initialWhere = baseWhere({ search, category, status, dateFrom, dateTo });",
  'report baseWhere entry date filters'
);

fs.writeFileSync(path, src);
console.log('Asset report operation date backend patch applied.');

// Workflow trigger marker.
