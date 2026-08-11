const fs = require('fs');

const path = 'src/routes/assets.routes.js';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  source = source.replace(before, after);
}

const moduleSpecs = `
const SMART_EXTRACTION_MODULES = {
  deed: {
    label: 'الصكوك',
    guidance: 'اقرأ الصك أو الوثيقة العقارية. نوع الاستخدام يجب أن يكون نصاً عربياً كما يظهر في المستند. إذا كان التاريخ هجرياً أعد التاريخ بصيغة YYYY-MM-DD وأعد deedDateType بقيمة hijri، وإلا gregorian.',
    fields: {
      deedNumber: { label: 'رقم الصك', type: 'text' }, deedDate: { label: 'تاريخ الصك', type: 'date' }, deedDateType: { label: 'نوع تاريخ الصك', type: 'enum', values: ['gregorian', 'hijri'] },
      propertyDescription: { label: 'بيان العقار', type: 'text' }, plotNumber: { label: 'رقم القطعة', type: 'text' }, planNumber: { label: 'رقم المخطط', type: 'text' },
      area: { label: 'المساحة بالمتر المربع', type: 'number' }, location: { label: 'الموقع التفصيلي', type: 'text' }, region: { label: 'المنطقة', type: 'text' }, city: { label: 'المدينة', type: 'text' },
      district: { label: 'الحي', type: 'text' }, usageType: { label: 'نوع الاستخدام', type: 'text' }, latitude: { label: 'خط العرض', type: 'number' }, longitude: { label: 'خط الطول', type: 'number' }, notes: { label: 'ملاحظات', type: 'text' },
    },
  },
  allocated_land: {
    label: 'الأراضي المخصصة',
    guidance: 'اقرأ قرار التخصيص أو المخطط أو المستند العقاري. usageType إن أمكن يجب أن تكون واحدة من residential, commercial, industrial, agricultural, educational, governmental, mixed, other.',
    fields: {
      propertyDescription: { label: 'بيان العقار', type: 'text' }, plotNumber: { label: 'رقم القطعة', type: 'text' }, planNumber: { label: 'رقم المخطط', type: 'text' }, area: { label: 'المساحة', type: 'number' },
      usageType: { label: 'نوع الاستخدام', type: 'enum', values: ['residential', 'commercial', 'industrial', 'agricultural', 'educational', 'governmental', 'mixed', 'other'] }, region: { label: 'المنطقة', type: 'text' },
      city: { label: 'المدينة', type: 'text' }, district: { label: 'الحي', type: 'text' }, coordinates: { label: 'الإحداثيات كنص', type: 'text' }, latitude: { label: 'خط العرض', type: 'number' }, longitude: { label: 'خط الطول', type: 'number' },
      googleEarthLink: { label: 'رابط Google Earth', type: 'text' }, notes: { label: 'ملاحظات', type: 'text' },
    },
  },
  delivered_land: {
    label: 'الأراضي المسلّمة',
    guidance: 'اقرأ محضر التسليم وما يرتبط به من مخطط أو وثيقة. إذا كان تاريخ التسليم هجرياً أعد deliveryDateType بقيمة hijri وإلا gregorian.',
    fields: {
      recipientEntity: { label: 'الجهة المستلمة', type: 'text' }, deliveryDate: { label: 'تاريخ التسليم', type: 'date' }, deliveryDateType: { label: 'نوع تاريخ التسليم', type: 'enum', values: ['gregorian', 'hijri'] },
      propertyDescription: { label: 'بيان العقار', type: 'text' }, plotNumber: { label: 'رقم القطعة', type: 'text' }, planNumber: { label: 'رقم المخطط', type: 'text' }, area: { label: 'المساحة', type: 'number' },
      location: { label: 'الموقع', type: 'text' }, coordinates: { label: 'الإحداثيات كنص', type: 'text' }, latitude: { label: 'خط العرض', type: 'number' }, longitude: { label: 'خط الطول', type: 'number' },
      deliveryMinutesNumber: { label: 'رقم محضر التسليم', type: 'text' }, notes: { label: 'ملاحظات', type: 'text' },
    },
  },
  leased_land_out: {
    label: 'عقود تأجير الأراضي',
    guidance: 'الجامعة هي المؤجّر. استخرج بيانات المستأجر والعقد والأرض. مفاتيح tenant.* يجب أن تبقى كما هي. أعد نوع كل تاريخ contractStartDateType وcontractEndDateType.',
    fields: {
      'tenant.name': { label: 'اسم المستأجر', type: 'text' }, 'tenant.commercialRegistration': { label: 'السجل التجاري', type: 'text' }, 'tenant.entityRepresentative': { label: 'ممثل الجهة', type: 'text' },
      'tenant.identityNumber': { label: 'رقم الهوية', type: 'text' }, 'tenant.nationality': { label: 'الجنسية', type: 'text' }, 'tenant.mobileNumber': { label: 'رقم الجوال', type: 'text' },
      contractNumber: { label: 'رقم العقد', type: 'text' }, contractStartDate: { label: 'تاريخ بداية العقد', type: 'date' }, contractStartDateType: { label: 'نوع تاريخ البداية', type: 'enum', values: ['gregorian', 'hijri'] },
      contractEndDate: { label: 'تاريخ نهاية العقد', type: 'date' }, contractEndDateType: { label: 'نوع تاريخ النهاية', type: 'enum', values: ['gregorian', 'hijri'] }, contractDuration: { label: 'مدة العقد', type: 'text' },
      plotNumber: { label: 'رقم القطعة', type: 'text' }, planNumber: { label: 'رقم المخطط', type: 'text' }, area: { label: 'المساحة', type: 'number' }, location: { label: 'الموقع', type: 'text' },
      coordinates: { label: 'الإحداثيات', type: 'text' }, latitude: { label: 'خط العرض', type: 'number' }, longitude: { label: 'خط الطول', type: 'number' }, rentAmount: { label: 'قيمة الإيجار', type: 'number' }, notes: { label: 'ملاحظات', type: 'text' },
    },
  },
  leased_land_in: {
    label: 'عقود استئجار الأراضي',
    guidance: 'الجامعة هي المستأجر. استخرج بيانات المالك والعقد والأرض. مفاتيح owner.* يجب أن تبقى كما هي. أعد نوع كل تاريخ contractStartDateType وcontractEndDateType.',
    fields: {
      'owner.name': { label: 'اسم المالك', type: 'text' }, 'owner.commercialRegistration': { label: 'السجل التجاري', type: 'text' }, 'owner.entityRepresentative': { label: 'ممثل الجهة', type: 'text' },
      'owner.identityNumber': { label: 'رقم الهوية', type: 'text' }, 'owner.nationality': { label: 'الجنسية', type: 'text' }, 'owner.mobileNumber': { label: 'رقم الجوال', type: 'text' },
      contractNumber: { label: 'رقم العقد', type: 'text' }, contractStartDate: { label: 'تاريخ بداية العقد', type: 'date' }, contractStartDateType: { label: 'نوع تاريخ البداية', type: 'enum', values: ['gregorian', 'hijri'] },
      contractEndDate: { label: 'تاريخ نهاية العقد', type: 'date' }, contractEndDateType: { label: 'نوع تاريخ النهاية', type: 'enum', values: ['gregorian', 'hijri'] }, contractDuration: { label: 'مدة العقد', type: 'text' },
      propertyDescription: { label: 'بيان العقار', type: 'text' }, area: { label: 'المساحة', type: 'number' }, location: { label: 'الموقع', type: 'text' }, coordinates: { label: 'الإحداثيات', type: 'text' },
      latitude: { label: 'خط العرض', type: 'number' }, longitude: { label: 'خط الطول', type: 'number' }, rentAmount: { label: 'قيمة الإيجار', type: 'number' }, notes: { label: 'ملاحظات', type: 'text' },
    },
  },
  leased_building_out: {
    label: 'عقود تأجير المباني',
    guidance: 'الجامعة هي المؤجّر. استخرج بيانات المستأجر والعقد والمبنى. مفاتيح tenant.* يجب أن تبقى كما هي، وأعد نوع تاريخ البداية والنهاية.',
    fields: {
      'tenant.name': { label: 'اسم المستأجر', type: 'text' }, 'tenant.commercialRegistration': { label: 'السجل التجاري', type: 'text' }, 'tenant.entityRepresentative': { label: 'ممثل الجهة', type: 'text' },
      'tenant.identityNumber': { label: 'رقم الهوية', type: 'text' }, 'tenant.nationality': { label: 'الجنسية', type: 'text' }, 'tenant.mobileNumber': { label: 'رقم الجوال', type: 'text' },
      contractNumber: { label: 'رقم العقد', type: 'text' }, contractStartDate: { label: 'تاريخ بداية العقد', type: 'date' }, contractStartDateType: { label: 'نوع تاريخ البداية', type: 'enum', values: ['gregorian', 'hijri'] },
      contractEndDate: { label: 'تاريخ نهاية العقد', type: 'date' }, contractEndDateType: { label: 'نوع تاريخ النهاية', type: 'enum', values: ['gregorian', 'hijri'] }, buildingNumber: { label: 'رقم المبنى', type: 'text' }, planNumber: { label: 'رقم المخطط', type: 'text' },
      locationName: { label: 'اسم أو موقع المبنى', type: 'text' }, area: { label: 'المساحة', type: 'number' }, city: { label: 'المدينة', type: 'text' }, district: { label: 'الحي', type: 'text' }, coordinates: { label: 'الإحداثيات', type: 'text' },
      latitude: { label: 'خط العرض', type: 'number' }, longitude: { label: 'خط الطول', type: 'number' }, rentAmount: { label: 'قيمة الإيجار', type: 'number' }, notes: { label: 'ملاحظات', type: 'text' },
    },
  },
  leased_building_in: {
    label: 'عقود استئجار المباني',
    guidance: 'الجامعة هي المستأجر. استخرج بيانات المالك والعقد والمبنى. مفاتيح owner.* يجب أن تبقى كما هي، وأعد نوع تاريخ البداية والنهاية.',
    fields: {
      'owner.name': { label: 'اسم المالك', type: 'text' }, 'owner.commercialRegistration': { label: 'السجل التجاري', type: 'text' }, 'owner.entityRepresentative': { label: 'ممثل الجهة', type: 'text' },
      'owner.identityNumber': { label: 'رقم الهوية', type: 'text' }, 'owner.nationality': { label: 'الجنسية', type: 'text' }, 'owner.mobileNumber': { label: 'رقم الجوال', type: 'text' },
      contractNumber: { label: 'رقم العقد', type: 'text' }, contractStartDate: { label: 'تاريخ بداية العقد', type: 'date' }, contractStartDateType: { label: 'نوع تاريخ البداية', type: 'enum', values: ['gregorian', 'hijri'] },
      contractEndDate: { label: 'تاريخ نهاية العقد', type: 'date' }, contractEndDateType: { label: 'نوع تاريخ النهاية', type: 'enum', values: ['gregorian', 'hijri'] }, buildingNumber: { label: 'رقم المبنى', type: 'text' },
      locationName: { label: 'اسم أو موقع المبنى', type: 'text' }, area: { label: 'المساحة', type: 'number' }, region: { label: 'المنطقة', type: 'text' }, city: { label: 'المدينة', type: 'text' }, coordinates: { label: 'الإحداثيات', type: 'text' },
      latitude: { label: 'خط العرض', type: 'number' }, longitude: { label: 'خط الطول', type: 'number' }, rentAmount: { label: 'قيمة الإيجار', type: 'number' }, notes: { label: 'ملاحظات', type: 'text' },
    },
  },
  site_inspection: {
    label: 'المعاينات الميدانية',
    guidance: 'اقرأ محضر المعاينة أو خطاب التكليف أو الوثيقة المرجعية. siteType يجب أن تكون واحدة من land, building, facility, general_site, other. أعد نوع التاريخ عند ظهوره.',
    fields: {
      title: { label: 'عنوان المعاينة', type: 'text' }, siteType: { label: 'نوع الموقع', type: 'enum', values: ['land', 'building', 'facility', 'general_site', 'other'] }, siteName: { label: 'اسم الموقع', type: 'text' },
      visitDate: { label: 'تاريخ الزيارة', type: 'date' }, visitDateType: { label: 'نوع تاريخ الزيارة', type: 'enum', values: ['gregorian', 'hijri'] }, visitPurpose: { label: 'غرض الزيارة', type: 'text' },
      inspectorName: { label: 'القائم بالمعاينة', type: 'text' }, accompanyingEntity: { label: 'الجهة المرافقة', type: 'text' }, region: { label: 'المنطقة', type: 'text' }, city: { label: 'المدينة', type: 'text' },
      district: { label: 'الحي', type: 'text' }, locationDescription: { label: 'وصف الموقع', type: 'text' }, deedNumber: { label: 'رقم الصك', type: 'text' }, plotNumber: { label: 'رقم القطعة', type: 'text' }, planNumber: { label: 'رقم المخطط', type: 'text' },
      latitude: { label: 'خط العرض', type: 'number' }, longitude: { label: 'خط الطول', type: 'number' }, observations: { label: 'الملاحظات', type: 'text' }, recommendedAction: { label: 'الإجراء المقترح', type: 'text' },
      referredEntity: { label: 'الجهة المحال إليها', type: 'text' }, followUpDate: { label: 'تاريخ المتابعة', type: 'date' }, followUpDateType: { label: 'نوع تاريخ المتابعة', type: 'enum', values: ['gregorian', 'hijri'] },
    },
  },
};

const readSmartPath = (object, path) => {
  if (!object || typeof object !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(object, path)) return object[path];
  return String(path).split('.').reduce((current, part) => (current && typeof current === 'object' ? current[part] : undefined), object);
};

const cleanGenericDate = (value) => {
  const text = cleanSmartString(value);
  if (!text) return null;
  const match = text.match(/^(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1200 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return \`\${String(year).padStart(4, '0')}-\${String(month).padStart(2, '0')}-\${String(day).padStart(2, '0')}\`;
};

const normalizeGenericSmartExtraction = (payload, spec) => {
  const sourceFields = payload?.fields && typeof payload.fields === 'object' ? payload.fields : payload || {};
  const fields = {};
  for (const [key, config] of Object.entries(spec.fields)) {
    const raw = readSmartPath(sourceFields, key);
    if (config.type === 'number') fields[key] = cleanSmartNumber(raw);
    else if (config.type === 'date') fields[key] = cleanGenericDate(raw);
    else if (config.type === 'enum') {
      const value = cleanSmartString(raw);
      fields[key] = value && config.values.includes(value) ? value : null;
    } else fields[key] = cleanSmartString(raw);
  }
  const confidenceRaw = Number(payload?.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : null;
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings.map(cleanSmartString).filter(Boolean).slice(0, 10) : [];
  return { fields, confidence, warnings, summary: cleanSmartString(payload?.summary) };
};

const buildGenericExtractionPrompt = (spec) => {
  const fieldLines = Object.entries(spec.fields).map(([key, config]) => {
    const typeHint = config.type === 'number' ? 'رقم فقط' : config.type === 'date' ? 'YYYY-MM-DD' : config.type === 'enum' ? \`واحدة من: \${config.values.join(', ')}\` : 'نص';
    return \`- \${key}: \${config.label} (\${typeHint})\`;
  });
  return [
    \`أنت نظام استخراج بيانات \${spec.label} لجامعة الإمام عبدالرحمن بن فيصل.\`,
    'اقرأ جميع الصور وملفات PDF المرفقة باعتبارها صفحات أو مستندات مرتبطة بنفس السجل. اربط المعلومات بين الصفحات ولا تخمّن أي قيمة غير ظاهرة أو غير مدعومة بوضوح.',
    'أعد JSON صالحاً فقط بدون Markdown بالشكل: {"fields":{...},"confidence":0.0,"warnings":[],"summary":""}.',
    'استخدم أسماء المفاتيح التالية حرفياً كما هي، بما فيها المفاتيح التي تحتوي نقطة مثل owner.name أو tenant.name:',
    ...fieldLines,
    spec.guidance,
    'بالنسبة للمبالغ والمساحات والإحداثيات العددية أعد أرقاماً فقط دون وحدات أو رموز. بالنسبة للتواريخ لا تحوّل بين الهجري والميلادي من عندك؛ أعد الرقم كما يظهر بصيغة YYYY-MM-DD وحدد حقل نوع التاريخ المناسب إن كان موجوداً.',
    'إذا لم يظهر الحقل بثقة فضع null. confidence رقم من 0 إلى 1، وwarnings ملاحظات قصيرة عند وجود غموض.',
  ].join('\\n');
};
`;

replaceOnce(
  "const SMART_EXTRACTION_CATEGORIES = new Set(['it', 'furniture', 'equipment', 'vehicle', 'land', 'other']);\n",
  "const SMART_EXTRACTION_CATEGORIES = new Set(['it', 'furniture', 'equipment', 'vehicle', 'land', 'other']);\n" + moduleSpecs,
  'module specs insertion'
);

replaceOnce(
  "    const smartFiles = [\n      ...((req.files?.files || [])),\n      ...((req.files?.file || [])),\n    ].slice(0, 8);\n    if (!smartFiles.length) return res.status(400).json({ message: 'اختر صورة أو ملف PDF واحدًا على الأقل لاستخراج بيانات الأصل.' });",
  "    const moduleKey = String(req.body?.module || 'asset').trim();\n    const moduleSpec = moduleKey === 'asset' ? null : SMART_EXTRACTION_MODULES[moduleKey];\n    if (moduleKey !== 'asset' && !moduleSpec) return res.status(400).json({ message: 'نوع السجل المطلوب للاستخراج الذكي غير مدعوم.' });\n    const smartFiles = [\n      ...((req.files?.files || [])),\n      ...((req.files?.file || [])),\n    ].slice(0, 8);\n    if (!smartFiles.length) return res.status(400).json({ message: 'اختر صورة أو ملف PDF واحدًا على الأقل للاستخراج الذكي.' });",
  'module selection'
);

const oldPrompt = `    const extractionPrompt = [
      'أنت نظام استخراج بيانات أصول لجامعة الإمام عبدالرحمن بن فيصل.',
      'اقرأ جميع الصور والمستندات المرفقة بدقة باعتبارها صفحات أو مستندات مرتبطة بنفس عملية إدخال الأصل. اربط المعلومات المتكاملة بين الصفحات، واستخرج فقط المعلومات الظاهرة أو المدعومة بوضوح. لا تخمّن أرقاماً أو قيماً غير موجودة.',
      'أعد JSON صالحاً فقط بدون Markdown بالشكل: {"fields":{...},"confidence":0.0,"warnings":[],"summary":""}.',
      'الحقول المسموحة داخل fields: itemNumber, barcode, name, category, brand, model, serialNumber, purchaseDate, purchaseValue, vatRate, vatAmount, purchaseValueBeforeVat, purchaseValueIncludingVat, department, building, floor, room, manufacturer, entityName, region, city, assetDescription, supplier, invoiceNumber, currency.',
      'purchaseDate يجب أن يكون YYYY-MM-DD إن أمكن. purchaseValue وpurchaseValueBeforeVat يمثلان القيمة قبل الضريبة إن ظهرت بوضوح، vatRate نسبة الضريبة، vatAmount قيمة الضريبة، وpurchaseValueIncludingVat الإجمالي شامل الضريبة. جميع القيم المالية أرقام فقط دون رمز العملة.',
      'النسبة الأساسية الحالية لضريبة القيمة المضافة في المملكة العربية السعودية هي 15%. إذا لم تظهر الضريبة بوضوح في المستند فلا تخمّن أنها مطبقة؛ أعد الحقول الضريبية null وسيطبق النظام النسبة الأساسية افتراضيًا عند الإدخال.',
      'category يجب أن تكون قيمة واحدة فقط من: it لتقنية المعلومات، furniture للأثاث، equipment للأجهزة والمعدات، vehicle للمركبات، land للأراضي، other لأي تصنيف آخر.',
      'إذا لم يظهر الحقل بثقة ضع null. استخرج اسم الصنف والمبلغ والماركة والموديل والرقم التسلسلي والباركود والجهة والموقع من الفواتير أو ملصقات الأصول بقدر المستطاع.',
      'confidence رقم من 0 إلى 1 يعكس ثقتك العامة، وwarnings ملاحظات قصيرة عند وجود غموض.',
    ].join('\\n');`;

const newPrompt = `    const assetExtractionPrompt = [
      'أنت نظام استخراج بيانات أصول لجامعة الإمام عبدالرحمن بن فيصل.',
      'اقرأ جميع الصور والمستندات المرفقة بدقة باعتبارها صفحات أو مستندات مرتبطة بنفس عملية إدخال الأصل. اربط المعلومات المتكاملة بين الصفحات، واستخرج فقط المعلومات الظاهرة أو المدعومة بوضوح. لا تخمّن أرقاماً أو قيماً غير موجودة.',
      'أعد JSON صالحاً فقط بدون Markdown بالشكل: {"fields":{...},"confidence":0.0,"warnings":[],"summary":""}.',
      'الحقول المسموحة داخل fields: itemNumber, barcode, name, category, brand, model, serialNumber, purchaseDate, purchaseValue, vatRate, vatAmount, purchaseValueBeforeVat, purchaseValueIncludingVat, department, building, floor, room, manufacturer, entityName, region, city, assetDescription, supplier, invoiceNumber, currency.',
      'purchaseDate يجب أن يكون YYYY-MM-DD إن أمكن. purchaseValue وpurchaseValueBeforeVat يمثلان القيمة قبل الضريبة إن ظهرت بوضوح، vatRate نسبة الضريبة، vatAmount قيمة الضريبة، وpurchaseValueIncludingVat الإجمالي شامل الضريبة. جميع القيم المالية أرقام فقط دون رمز العملة.',
      'النسبة الأساسية الحالية لضريبة القيمة المضافة في المملكة العربية السعودية هي 15%. إذا لم تظهر الضريبة بوضوح في المستند فلا تخمّن أنها مطبقة؛ أعد الحقول الضريبية null وسيطبق النظام النسبة الأساسية افتراضيًا عند الإدخال.',
      'category يجب أن تكون قيمة واحدة فقط من: it لتقنية المعلومات، furniture للأثاث، equipment للأجهزة والمعدات، vehicle للمركبات، land للأراضي، other لأي تصنيف آخر.',
      'إذا لم يظهر الحقل بثقة ضع null. استخرج اسم الصنف والمبلغ والماركة والموديل والرقم التسلسلي والباركود والجهة والموقع من الفواتير أو ملصقات الأصول بقدر المستطاع.',
      'confidence رقم من 0 إلى 1 يعكس ثقتك العامة، وwarnings ملاحظات قصيرة عند وجود غموض.',
    ].join('\\n');
    const extractionPrompt = moduleKey === 'asset' ? assetExtractionPrompt : buildGenericExtractionPrompt(moduleSpec);`;

replaceOnce(oldPrompt, newPrompt, 'dynamic extraction prompt');

replaceOnce(
  "        model: String(process.env.OPENAI_ASSET_EXTRACTION_MODEL || 'gpt-5-mini'),",
  "        model: String(process.env.OPENAI_SMART_EXTRACTION_MODEL || process.env.OPENAI_ASSET_EXTRACTION_MODEL || 'gpt-5-mini'),",
  'generic model env'
);

replaceOnce(
  "    const parsed = parseSmartExtractionJson(responseOutputText(openAiPayload));\n    const normalized = normalizeSmartExtraction(parsed);\n    res.json({\n      ...normalized,",
  "    const parsed = parseSmartExtractionJson(responseOutputText(openAiPayload));\n    const normalized = moduleKey === 'asset' ? normalizeSmartExtraction(parsed) : normalizeGenericSmartExtraction(parsed, moduleSpec);\n    res.json({\n      ...normalized,\n      module: moduleKey,",
  'generic normalizer'
);

fs.writeFileSync(path, source);
console.log('Generalized smart extraction endpoint for platform record modules.');
