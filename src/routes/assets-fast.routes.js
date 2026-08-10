import { Router } from 'express';
import { prisma } from '../prisma.js';

const router = Router();

const normalize = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي')
  .replace(/\s+/g, ' ')
  .trim();

const GROUP_RULES = [
  { key: 'ups', label: 'أجهزة UPS والطاقة الاحتياطية', patterns: [/\bups\b/i, /مزود طاقه غير منقطع/, /عدم انقطاع/, /uninterruptible/] },
  { key: 'printers', label: 'الطابعات وأجهزة النسخ', patterns: [/طابع/, /طباعه/, /ناسخ/, /ماكينه تصوير/, /printer/i, /copier/i] },
  { key: 'chairs', label: 'الكراسي', patterns: [/كرسي/, /كراسي/, /chair/i] },
  { key: 'tables', label: 'الطاولات', patterns: [/طاول/, /طاوله/, /table/i] },
  { key: 'desks', label: 'المكاتب', patterns: [/مكتب/, /desk/i] },
  { key: 'cabinets', label: 'الخزائن والكبائن', patterns: [/خزان/, /خزانه/, /كبين/, /كابينه/, /cabinet/i, /locker/i] },
  { key: 'computers', label: 'أجهزة الحاسب', patterns: [/حاسب/, /كمبيوتر/, /computer/i, /desktop/i, /laptop/i, /workstation/i] },
  { key: 'displays', label: 'الشاشات وأجهزة العرض', patterns: [/شاشه/, /بروجكتر/, /عارض/, /monitor/i, /projector/i, /display/i] },
  { key: 'network', label: 'أجهزة الشبكات والاتصالات', patterns: [/سويتش/, /راوتر/, /شبك/, /هاتف/, /سنترال/, /router/i, /switch/i, /network/i, /telephone/i] },
  { key: 'hvac', label: 'أجهزة التكييف والتبريد', patterns: [/تكييف/, /مكيف/, /تبريد/, /ثلاج/, /air condition/i, /refriger/i] },
  { key: 'power', label: 'المولدات والطاقة', patterns: [/مولد/, /generator/i, /محول كهرب/, /transformer/i] },
  { key: 'medical', label: 'الأجهزة الطبية والمخبرية', patterns: [/مختبر/, /طبي/, /معمل/, /microscope/i, /laboratory/i, /medical/i] },
  { key: 'vehicles', label: 'المركبات ووسائل النقل', patterns: [/سيار/, /مركب/, /حافل/, /شاحن/, /vehicle/i, /car/i, /bus/i, /truck/i] },
  { key: 'lands', label: 'الأراضي', patterns: [/ارض/, /اراضي/, /land/i] },
  { key: 'intangible', label: 'الأصول غير الملموسة', patterns: [/برنامج/, /رخصه/, /نظام/, /software/i, /license/i, /intangible/i] },
  { key: 'infrastructure', label: 'البنية التحتية', patterns: [/بنيه تحتيه/, /شبكه مياه/, /شبكه صرف/, /طريق/, /رصيف/, /infrastructure/i] },
];

const CATEGORY_LABELS = {
  it: 'تقنية معلومات',
  furniture: 'الأثاث',
  equipment: 'الآلات والمعدات',
  vehicle: 'أصول النقل العام',
  infrastructure: 'البنية التحتية',
  intangible: 'الأصول غير الملموسة',
  land: 'الأراضي',
  other: 'أخرى',
};

const classify = (asset) => {
  const primary = normalize([asset.name, asset.assetDescription].filter(Boolean).join(' '));
  for (const rule of GROUP_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(primary))) return { key: rule.key, label: rule.label };
  }
  const category = String(asset.category || 'other');
  return { key: `category:${category}`, label: CATEGORY_LABELS[category] || category || 'أصول أخرى' };
};

const compactSelect = {
  id: true,
  itemNumber: true,
  assetNumber: true,
  barcode: true,
  name: true,
  category: true,
  brand: true,
  model: true,
  serialNumber: true,
  status: true,
  technicalCondition: true,
  department: true,
  building: true,
  floor: true,
  room: true,
  entityName: true,
  responsibleDepartment: true,
  assetDescription: true,
  cardNumber: true,
  assetCode: true,
  quantity: true,
  createdAt: true,
};

const reportSelect = {
  ...compactSelect,
  custodian: true,
  purchaseDate: true,
  purchaseDateType: true,
  purchaseValue: true,
  acquisitionCost: true,
  manufacturer: true,
  region: true,
  city: true,
  buildingNumber: true,
  coordinates: true,
  classification1: true,
  classification2: true,
  classification3: true,
  classification4: true,
  classification5: true,
  classification6: true,
  accountingGroup: true,
  accountingGroupCode: true,
  remainingLife: true,
  usefulLife: true,
  serviceDate: true,
  lastInventoryDate: true,
  unitOfMeasure: true,
  excelPayload: true,
  notes: true,
};

const searchWhere = (search) => search ? {
  OR: [
    { itemNumber: { contains: search, mode: 'insensitive' } },
    { assetNumber: { contains: search, mode: 'insensitive' } },
    { barcode: { contains: search, mode: 'insensitive' } },
    { name: { contains: search, mode: 'insensitive' } },
    { assetDescription: { contains: search, mode: 'insensitive' } },
    { serialNumber: { contains: search, mode: 'insensitive' } },
    { department: { contains: search, mode: 'insensitive' } },
    { responsibleDepartment: { contains: search, mode: 'insensitive' } },
    { building: { contains: search, mode: 'insensitive' } },
    { room: { contains: search, mode: 'insensitive' } },
    { cardNumber: { contains: search, mode: 'insensitive' } },
    { assetCode: { contains: search, mode: 'insensitive' } },
  ],
} : {};

const baseWhere = ({ search, category, status }) => ({
  ...(category && category !== 'all' ? { category } : {}),
  ...(status && status !== 'all' ? { status } : {}),
  ...searchWhere(search),
});

const matchingGroupIds = async (groupKey, where = {}) => {
  if (!groupKey || groupKey === 'all') return null;
  const candidates = await prisma.asset.findMany({
    where,
    select: { id: true, name: true, assetDescription: true, category: true },
  });
  return candidates.filter((item) => classify(item).key === groupKey).map((item) => item.id);
};

const attachmentCountsFor = async (items) => {
  const ids = items.map((item) => item.id);
  if (!ids.length) return {};
  const grouped = await prisma.attachment.groupBy({
    by: ['entityId'],
    where: { entityType: 'asset', entityId: { in: ids } },
    _count: { _all: true },
  });
  return Object.fromEntries(grouped.map((item) => [item.entityId, item._count._all]));
};

router.get('/groups', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    const status = String(req.query.status || '').trim();
    const records = await prisma.asset.findMany({
      where: baseWhere({ search, category, status }),
      select: { id: true, name: true, assetDescription: true, category: true, quantity: true },
    });
    const groups = new Map();
    for (const record of records) {
      const group = classify(record);
      const current = groups.get(group.key) || { key: group.key, label: group.label, count: 0, quantity: 0 };
      current.count += 1;
      const quantity = Number(record.quantity);
      current.quantity += Number.isFinite(quantity) ? quantity : 1;
      groups.set(group.key, current);
    }
    res.setHeader('Cache-Control', 'private, max-age=20');
    res.json(Array.from(groups.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ar')));
  } catch (error) { next(error); }
});

router.get('/list', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const groupKey = String(req.query.group || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(12, Number(req.query.limit) || 36));
    const initialWhere = baseWhere({ search, category: '', status: '' });
    const ids = await matchingGroupIds(groupKey, initialWhere);
    if (ids && !ids.length) return res.json({ items: [], page, limit, total: 0, totalPages: 0 });
    const where = { ...initialWhere, ...(ids ? { id: { in: ids } } : {}) };
    const [total, items] = await Promise.all([
      prisma.asset.count({ where }),
      prisma.asset.findMany({ where, select: compactSelect, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
    ]);
    const attachmentCounts = await attachmentCountsFor(items);
    res.setHeader('Cache-Control', 'private, max-age=15');
    res.json({ items: items.map((item) => ({ ...item, attachmentsCount: attachmentCounts[item.id] || 0 })), page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.get('/report', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    const status = String(req.query.status || '').trim();
    const groupKey = String(req.query.group || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const all = String(req.query.all || '') === '1';
    const limit = all ? 10000 : Math.min(200, Math.max(20, Number(req.query.limit) || 50));
    const sortKeyRaw = String(req.query.sortKey || 'itemNumber');
    const sortDirection = String(req.query.sortDirection || 'asc') === 'desc' ? 'desc' : 'asc';
    const allowedSort = new Set(['itemNumber', 'assetNumber', 'barcode', 'name', 'category', 'status', 'department', 'building', 'floor', 'room', 'purchaseDate', 'purchaseValue', 'createdAt']);
    const sortKey = allowedSort.has(sortKeyRaw) ? sortKeyRaw : 'itemNumber';

    const initialWhere = baseWhere({ search, category, status });
    const ids = await matchingGroupIds(groupKey, initialWhere);
    if (ids && !ids.length) return res.json({ items: [], page, limit, total: 0, totalPages: 0, groups: [] });
    const where = { ...initialWhere, ...(ids ? { id: { in: ids } } : {}) };

    const [total, items] = await Promise.all([
      prisma.asset.count({ where }),
      prisma.asset.findMany({
        where,
        select: reportSelect,
        orderBy: [{ [sortKey]: sortDirection }, { id: 'asc' }],
        ...(all ? {} : { skip: (page - 1) * limit, take: limit }),
      }),
    ]);
    const attachmentCounts = await attachmentCountsFor(items);
    const resultItems = items.map((item) => ({ ...item, attachmentsCount: attachmentCounts[item.id] || 0 }));
    res.setHeader('Cache-Control', all ? 'private, no-store' : 'private, max-age=10');
    res.json({ items: resultItems, page: all ? 1 : page, limit, total, totalPages: all ? 1 : Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

export default router;
