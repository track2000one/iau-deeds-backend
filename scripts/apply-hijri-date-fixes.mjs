import fs from 'node:fs';

const replaceOnce = (source, before, after, label) => {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(before, after);
};

const hijriHelpers = `const hijriParts = (date) => {\n  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {\n    year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC'\n  }).formatToParts(date);\n  const get = (partType) => Number(parts.find((part) => part.type === partType)?.value);\n  return { year: get('year'), month: get('month'), day: get('day') };\n};\n\nconst hijriToGregorian = (year, month, day) => {\n  const roughYear = year + 579;\n  const center = Date.UTC(roughYear, Math.max(0, month - 1), Math.min(day, 28), 12, 0, 0);\n  for (let offset = -420; offset <= 420; offset += 1) {\n    const candidate = new Date(center + offset * 86400000);\n    const hijri = hijriParts(candidate);\n    if (hijri.year === year && hijri.month === month && hijri.day === day) return candidate;\n  }\n  return null;\n};\n\n`;

for (const file of ['src/routes/site-inspections.routes.js', 'src/routes/assets.routes.js']) {
  let src = fs.readFileSync(file, 'utf8');
  src = replaceOnce(
    src,
    "const toDate = (value, fieldName, type = 'gregorian') => {",
    `${hijriHelpers}const toDate = (value, fieldName, type = 'gregorian') => {`,
    `${file} Hijri helpers`,
  );
  src = replaceOnce(
    src,
    "    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));",
    "    const converted = hijriToGregorian(year, month, day);\n    if (!converted) {\n      const error = new Error(`${fieldName} الهجري غير صحيح أو خارج النطاق المدعوم`);\n      error.status = 400;\n      throw error;\n    }\n    return converted;",
    `${file} Hijri conversion`,
  );
  fs.writeFileSync(file, src);
}

const cyclesPath = 'src/routes/asset-cycles.routes.js';
let cycles = fs.readFileSync(cyclesPath, 'utf8');
cycles = replaceOnce(
  cycles,
  "const parseDateForDb = (value, type = 'gregorian') => {",
  `${hijriHelpers}const parseDateForDb = (value, type = 'gregorian') => {`,
  'asset cycles Hijri helpers',
);
cycles = replaceOnce(
  cycles,
  "    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0));",
  "    const year = Number(match[1]);\n    const month = Number(match[2]);\n    const day = Number(match[3]);\n    if (year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 30) return null;\n    return hijriToGregorian(year, month, day);",
  'asset cycles Hijri conversion',
);
fs.writeFileSync(cyclesPath, cycles);

console.log('Hijri date integrity fixes applied.');
