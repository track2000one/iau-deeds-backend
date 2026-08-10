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
  it: 'تقنية معلومات', furniture: 'الأثاث', equipment: 'الآلات والمعدات', vehicle: 'أصول النقل العام',
  infrastructure: 'البنية التحتية', intangible: 'الأصول غير الملموسة', land: 'الأراضي', other: 'أخرى',
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

const searchWhere = (search) => search ? {
  OR: [
    { itemNumber: { contains: search, mode: 'insensitive' } },
    { assetNumber: { contains: search, mode: 'insensitive' } },
    { barcode: { contains: search, mode: 'insensitive' } },
    { name: { contains: search, mode: 'insensitive' } },
    { serialNumber: { contains: search, mode: 'insensitive' } },
    { department: { contains: search, mode: 'insensitive' } },
    { responsibleDepartment: { contains: search, mode: 'insensitive' } },
    { cardNumber: { contains: search, mode: 'insensitive' } },
    { assetCode: { contains: search, mode: 'insensitive' } },
  ],
} : {};

router.get('/groups', async (_req, res, next) => {
  try {
    const records = await prisma.asset.findMany({
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
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json(Array.from(groups.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ar')));
  } catch (error) { next(error); }
});

router.get('/list', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const groupKey = String(req.query.group || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(12, Number(req.query.limit) || 36));
    let ids = null;

    if (groupKey) {
      const candidates = await prisma.asset.findMany({
        select: { id: true, name: true, assetDescription: true, category: true },
      });
      ids = candidates.filter((item) => classify(item).key === groupKey).map((item) => item.id);
      if (!ids.length) return res.json({ items: [], page, limit, total: 0, totalPages: 0 });
    }

    const where = {
      ...(ids ? { id: { in: ids } } : {}),
      ...searchWhere(search),
    };
    const [total, items] = await Promise.all([
      prisma.asset.count({ where }),
      prisma.asset.findMany({
        where,
        select: compactSelect,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const itemIds = items.map((item) => item.id);
    const attachments = itemIds.length ? await prisma.attachment.findMany({
      where: { entityType: 'asset', entityId: { in: itemIds } },
      select: { entityId: true },
    }) : [];
    const attachmentCounts = attachments.reduce((acc, item) => {
      acc[item.entityId] = (acc[item.entityId] || 0) + 1;
      return acc;
    }, {});

    res.setHeader('Cache-Control', 'private, max-age=15');
    res.json({
      items: items.map((item) => ({ ...item, attachmentsCount: attachmentCounts[item.id] || 0 })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) { next(error); }
});

export default router;
