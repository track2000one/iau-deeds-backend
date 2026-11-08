
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const toRiyadh = (value) => value
  ? new Date(value).toLocaleString('ar-SA-u-nu-latn', {
      timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hour12: true,
    })
  : '—';

const actionLabels = {
  login: 'دخول', logout: 'خروج', create: 'إضافة',
  update: 'تعديل', delete: 'حذف', upload: 'رفع مرفق',
  view: 'فتح قسم', export: 'تصدير',
};

const moduleLabels = {
  auth: 'الدخول والجلسات', users: 'المستخدمون', deeds: 'الصكوك',
  vacant_lands: 'الأراضي الشاغرة', central_buildings: 'السجل المركزي للمباني',
  transaction_follow_up: 'نظام المتابعة', mosques: 'المساجد والمصليات',
  accounting_transformation: 'التحول المحاسبي', assets: 'الأصول',
  site_inspections: 'المعاينات الميدانية', archive: 'الأرشفة',
  investments: 'الاستثمارات', audit: 'الرقابة', records: 'السجلات',
  contracts_followup: 'متابعة العقود', organization_units: 'الجهات والوحدات',
  dashboard: 'الرئيسية', reports: 'التقارير', attachments: 'المرفقات',
};

const privateFieldPattern = /password|token|secret|cookie|hash|authorization|private.?key|credential|jwt/i;
const formatPreview = (value) => {
  if (value === null || value === undefined) return 'فارغ';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 65 ? text.slice(0, 65) + '…' : text;
};
const normalize = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const nested = value.data || value.record || value.item;
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : value;
};

const changeDetails = (item) => {
  if (item.status === 'failed' && item.errorMessage) return item.errorMessage;
  if (item.action === 'update') {
    const before = normalize(item.previousData);
    const after = normalize(item.newData);
    if (before && after) {
      const fields = Object.keys(after).filter((key) =>
        Object.prototype.hasOwnProperty.call(before, key) &&
        !privateFieldPattern.test(key) &&
        JSON.stringify(before[key]) !== JSON.stringify(after[key])
      );
      if (fields.length) {
        const sample = fields.slice(0, 4).map((key) =>
          key + ': قبل (' + formatPreview(before[key]) + ')، بعد (' + formatPreview(after[key]) + ')'
        );
        if (fields.length > 4) sample.push('و' + (fields.length - 4) + ' حقول أخرى');
        return sample.join('؛ ');
      }
    }
  }
  return item.errorMessage || item.description || '';
};

const groupRecords = (items) => {
  const accountIdByEmail = new Map();
  for (const item of items) {
    if (item.userId && item.userEmail) accountIdByEmail.set(item.userEmail.toLowerCase(), item.userId);
  }

  const groups = new Map();
  for (const item of items) {
    const email = (item.userEmail || '').toLowerCase();
    const identity = item.userId || accountIdByEmail.get(email) ||
      (email ? 'email:' + email : (item.username ? 'name:' + item.username : 'unknown'));
    if (!groups.has(identity)) {
      groups.set(identity, {
        id: identity, username: item.username || item.userEmail || 'مستخدم غير معروف',
        email: item.userEmail || '', items: [],
      });
    }
    const group = groups.get(identity);
    if (item.userId && item.username) group.username = item.username;
    if (!group.email && item.userEmail) group.email = item.userEmail;
    group.items.push(item);
  }
  const collator = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });
  return Array.from(groups.values()).sort((a, b) => collator.compare(a.username, b.username));
};

const breakdown = (items) => {
  const counts = { total: items.length, login: 0, logout: 0,
    create: 0, update: 0, delete: 0, upload: 0, view: 0, failed: 0 };
  for (const item of items) {
    if (item.action in counts) counts[item.action]++;
    if (item.status === 'failed') counts.failed++;
  }
  return counts;
};

const statsTable = (groups) => {
  const header = ['المستخدم', 'الإجمالي', 'دخول', 'إضافة', 'تعديل', 'حذف', 'رفع', 'فتح أقسام', 'فاشلة'];
  const lines = groups.map((group) => {
    const c = breakdown(group.items);
    const values = [group.username, c.total, c.login, c.create, c.update,
      c.delete, c.upload, c.view, c.failed];
    return '<tr>' + values.map((v) => '<td>' + escapeHtml(v) + '</td>').join('') + '</tr>';
  }).join('');
  return '<div class="summary-block"><h3>ملخص النشاط حسب المستخدم</h3><table><thead><tr>' +
    header.map((v) => '<th>' + escapeHtml(v) + '</th>').join('') +
    '</tr></thead><tbody>' + lines + '</tbody></table></div>';
};

const renderUser = (group, index) => {
  const c = breakdown(group.items);
  const timestamps = group.items.map((item) => new Date(item.createdAt).getTime()).filter(Number.isFinite);
  const earliest = timestamps.length ? new Date(Math.min(...timestamps)) : null;
  const latest = timestamps.length ? new Date(Math.max(...timestamps)) : null;
  const badge = (name, value) => '<div class="metric"><span>' + escapeHtml(name) + '</span><strong>' +
    escapeHtml(value) + '</strong></div>';
  const header = ['م', 'التاريخ والوقت', 'نوع العملية', 'القسم', 'رقم / اسم السجل', 'الحالة',
    'عنوان IP', 'الوصف والتغييرات المسجلة'];
  const rows = group.items.map((item, i) => {
    const record = item.entityLabel || item.entityId || '—';
    const detail = changeDetails(item);
    const values = [i + 1, toRiyadh(item.createdAt), actionLabels[item.action] || item.action,
      moduleLabels[item.module] || item.module, record,
      item.status === 'success' ? 'ناجحة' : 'فاشلة', item.ipAddress || '—', detail];
    return '<tr>' + values.map((value, pos) => '<td class="' + (pos === 7 ? 'details' : '') +
      '">' + escapeHtml(value) + '</td>').join('') + '</tr>';
  }).join('');
  return '<section class="user-section">' +
    '<h2>التقرير التفصيلي للمستخدم (' + escapeHtml(index + 1) + '): ' + escapeHtml(group.username) + '</h2>' +
    '<div class="person-meta"><span>البريد: ' + escapeHtml(group.email || 'غير متوفر') + '</span>' +
    '<span>أول نشاط مسجل: ' + escapeHtml(toRiyadh(earliest)) + '</span>' +
    '<span>آخر نشاط مسجل: ' + escapeHtml(toRiyadh(latest)) + '</span></div>' +
    '<div class="metrics">' +
    badge('إجمالي العمليات', c.total) + badge('الدخول', c.login) +
    badge('الإضافات', c.create) + badge('التعديلات', c.update) +
    badge('الحذف', c.delete) + badge('رفع الملفات', c.upload) +
    badge('زيارة الأقسام', c.view) + badge('العمليات الفاشلة', c.failed) +
    '</div><h3>العمليات بالتفصيل</h3><table class="details-table"><thead><tr>' +
    header.map((value) => '<th>' + escapeHtml(value) + '</th>').join('') +
    '</tr></thead><tbody>' + (rows || '<tr><td colspan="8">لا توجد عمليات مسجلة ضمن معايير التقرير.</td></tr>') + '</tbody></table></section>';
};

const styles = [
  '@page{size:A4 landscape;margin:10mm}',
  '*{box-sizing:border-box}',
  'body{font-family:Tahoma,Arial,sans-serif;color:#142944;margin:0;font-size:10.5px;line-height:1.5;background:white}',
  'header{border-bottom:3px solid #25496c;padding:7px 0 14px;margin-bottom:13px}',
  'h1{font-size:18px;margin:0 0 5px}h2{font-size:15px;margin:10px 0}h3{font-size:12px;margin:8px 0}',
  '.issued,.criteria,.person-meta{display:flex;flex-wrap:wrap;gap:12px;color:#40576f}',
  '.criteria{margin:10px 0;padding:10px;border:1px solid #cfdce7;border-radius:6px;background:#f3f7fa}',
  '.summary-block{margin:14px 0 20px}',
  '.user-section{break-before:page;page-break-before:always;min-height:1px}',
  '.user-section.single-user{break-before:auto;page-break-before:auto}',
  '.person-meta{padding:7px 0;margin-bottom:7px}',
  '.metrics{display:grid;grid-template-columns:repeat(8,1fr);gap:5px;margin:12px 0}',
  '.metric{border:1px solid #d4e0eb;padding:8px 5px;text-align:center;border-radius:5px;break-inside:avoid}',
  '.metric span{display:block;color:#4b6276;font-size:9px}.metric strong{display:block;font-size:15px;margin-top:3px}',
  'table{border-collapse:collapse;width:100%;table-layout:fixed;direction:rtl}',
  'th,td{border:1px solid #c6d4e0;padding:5px 4px;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}',
  'thead th{background:#e8eff6;font-weight:bold;color:#1b3a57}',
  'tbody tr:nth-child(even){background:#f8fafc}',
  'thead{display:table-header-group}tr{page-break-inside:avoid;break-inside:avoid}',
  '.details-table th:nth-child(1){width:3%}.details-table th:nth-child(2){width:14%}',
  '.details-table th:nth-child(3){width:9%}.details-table th:nth-child(4){width:11%}',
  '.details-table th:nth-child(5){width:12%}.details-table th:nth-child(6){width:7%}',
  '.details-table th:nth-child(7){width:10%}.details-table th:nth-child(8){width:34%}',
  '.details{font-size:9.5px}',
  'footer{border-top:1px solid #d2dde8;padding:8px 0;margin-top:16px;color:#536b82;font-size:9px}',
  '.toolbar{position:sticky;top:0;background:#e9f1f8;padding:10px;text-align:left;border-bottom:1px solid #b6cad9;z-index:3}',
  'button{background:#204c72;color:white;padding:8px 18px;border:0;border-radius:5px;cursor:pointer}',
  '@media print{.toolbar{display:none}.user-section{break-before:page;page-break-before:always}.user-section.single-user{break-before:auto;page-break-before:auto}}',
].join('\n');

export const renderAuditUserPrintReport = ({ items, query, requestedUser = null }) => {
  const groups = groupRecords(items);
  if (!groups.length && requestedUser) {
    groups.push({
      id: requestedUser.id,
      username: requestedUser.username,
      email: requestedUser.email,
      items: [],
    });
  }
  const single = groups.length === 1;
  const total = items.length;
  const selectedCriteria = [
    query.from ? 'من ' + query.from : '',
    query.to ? 'إلى ' + query.to : '',
    query.userId ? 'تقرير مستخدم محدد' : 'جميع المستخدمين',
    query.action ? 'العملية: ' + (actionLabels[query.action] || query.action) : '',
    query.module ? 'القسم: ' + (moduleLabels[query.module] || query.module) : '',
    query.status ? 'الحالة: ' + (query.status === 'success' ? 'ناجحة' : 'فاشلة') : '',
    query.search ? 'البحث: ' + query.search : '',
    'الفرز: ' + ({
      createdAt: 'التاريخ', username: 'المستخدم', action: 'العملية',
      module: 'القسم', status: 'الحالة',
    }[query.sortBy] || 'التاريخ') + ' (' + (query.sortDir === 'asc' ? 'تصاعدي' : 'تنازلي') + ')',
  ].filter(Boolean).map(escapeHtml).join(' | ');

  const sections = groups.map((group, index) => {
    const content = renderUser(group, index);
    return single ? content.replace('class="user-section"', 'class="user-section single-user"') : content;
  }).join('');

  const summary = groups.length > 1 ? statsTable(groups) : '';
  const reportHeader = '<header><h1>جامعة الإمام عبدالرحمن بن فيصل</h1>' +
    '<h2>إدارة أوقاف وأملاك الجامعة</h2>' +
    '<h2>تقرير نشاط المستخدمين والرقابة على العمليات</h2>' +
    '<div class="issued"><span>تاريخ الإصدار: ' + escapeHtml(toRiyadh(new Date())) + '</span>' +
    '<span>عدد المستخدمين: ' + groups.length + '</span>' +
    '<span>عدد العمليات: ' + total + '</span><span>التوقيت: الرياض UTC+03:00</span></div></header>';
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>تقرير نشاط المستخدمين</title>' +
    '<style>' + styles + '</style></head><body>' +
    '<div class="toolbar"><button onclick="window.print()">طباعة التقرير / حفظ PDF</button></div>' +
    reportHeader + '<div class="criteria"><strong>معايير التقرير:</strong> ' +
    selectedCriteria + '</div>' + summary +
    (sections || '<p>لا توجد عمليات مطابقة لمعايير التصفية.</p>') +
    '<footer>هذا التقرير خاص بالمستخدم المخول، ويتضمن العمليات المسجلة في النظام فقط. ' +
    'لا يمثل مدة العمل الفعلية أو قياس الحضور والانصراف.</footer>' +
    '</body></html>';
};
