import { prisma } from '../prisma.js';

export const OFFICIAL_MOSQUE_SITES = [
  {
    name: 'مسجد 1',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشرقي C1',
    campusLocation: 'M1 — مقابل مبنى A4',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M1.',
  },
  {
    name: 'مسجد 2',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشرقي C1',
    campusLocation: 'M4 — بجانب السكن الطلابي',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M4.',
  },
  {
    name: 'مسجد 3',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشرقي C1',
    campusLocation: 'M5 — بالقرب من سكن أعضاء هيئة التدريس',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M5.',
  },
  {
    name: 'مسجد 4',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الغربي C1',
    campusLocation: 'M21 — مقابل مبنى كلية الهندسة A46',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M21.',
  },
  {
    name: 'مسجد 5',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الغربي C1',
    campusLocation: 'M25 — مقابل مبنى المستشفى الرئيسي H1',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M25.',
  },
  {
    name: 'مسجد 6',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشمالي C1',
    campusLocation: 'M28 — بالحرم الشمالي',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M28.',
  },
  {
    name: 'مسجد 7',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشمالي C1',
    campusLocation: 'M33 — بالجهة السكنية بالحرم الشمالي',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M33.',
  },
];

export async function ensureOfficialMosqueSites() {
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

  console.log(`Official mosque sites ensured: ${missing.length} created, ${OFFICIAL_MOSQUE_SITES.length} total.`);
  return { created: missing.length, total: OFFICIAL_MOSQUE_SITES.length };
}
