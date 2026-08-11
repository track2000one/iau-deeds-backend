import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../prisma.js';
import { createAuditLog, getClientIp } from '../services/audit.service.js';
import { uploadBufferToGoogleDrive, deleteGoogleDriveFile, downloadGoogleDriveFile } from '../services/googleDrive.js';

const router = Router();

const OFFICIAL_ASSET_TEMPLATE_KEY = 'official_assets_all';
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const officialExcelTemplateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    const allowed = file.mimetype === EXCEL_MIME || fileName.endsWith('.xlsx');
    cb(allowed ? null : new Error('القالب الرسمي يجب أن يكون ملف Excel بصيغة XLSX.'), allowed);
  },
});

const smartExtractionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    const allowed = file.mimetype?.startsWith('image/') || file.mimetype === 'application/pdf' || fileName.endsWith('.pdf');
    cb(allowed ? null : new Error('الاستخراج الذكي يدعم الصور وملفات PDF فقط.'), allowed);
  },
});

const SMART_EXTRACTION_CATEGORIES = new Set(['it', 'furniture', 'equipment', 'vehicle', 'land', 'other']);

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
  const match = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1200 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
    const typeHint = config.type === 'number' ? 'رقم فقط' : config.type === 'date' ? 'YYYY-MM-DD' : config.type === 'enum' ? `واحدة من: ${config.values.join(', ')}` : 'نص';
    return `- ${key}: ${config.label} (${typeHint})`;
  });
  return [
    `أنت نظام استخراج بيانات ${spec.label} لجامعة الإمام عبدالرحمن بن فيصل.`,
    'اقرأ جميع الصور وملفات PDF المرفقة باعتبارها صفحات أو مستندات مرتبطة بنفس السجل. اربط المعلومات بين الصفحات ولا تخمّن أي قيمة غير ظاهرة أو غير مدعومة بوضوح.',
    'أعد JSON صالحاً فقط بدون Markdown بالشكل: {"fields":{...},"confidence":0.0,"warnings":[],"summary":""}.',
    'استخدم أسماء المفاتيح التالية حرفياً كما هي، بما فيها المفاتيح التي تحتوي نقطة مثل owner.name أو tenant.name:',
    ...fieldLines,
    spec.guidance,
    'بالنسبة للمبالغ والمساحات والإحداثيات العددية أعد أرقاماً فقط دون وحدات أو رموز. بالنسبة للتواريخ لا تحوّل بين الهجري والميلادي من عندك؛ أعد الرقم كما يظهر بصيغة YYYY-MM-DD وحدد حقل نوع التاريخ المناسب إن كان موجوداً.',
    'إذا لم يظهر الحقل بثقة فضع null. confidence رقم من 0 إلى 1، وwarnings ملاحظات قصيرة عند وجود غموض.',
  ].join('\n');
};

const cleanSmartString = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 1000) : null;
};

const cleanSmartNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
};

const cleanSmartDate = (value) => {
  const text = cleanSmartString(value);
  if (!text) return null;
  const exact = text.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  if (exact) return exact;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const parseSmartExtractionJson = (text) => {
  const raw = String(text || '').trim().replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('لم تُرجع خدمة الاستخراج بيانات منظمة قابلة للقراءة.');
  return JSON.parse(raw.slice(start, end + 1));
};

const responseOutputText = (payload) => {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const parts = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }
  return parts.join('\n').trim();
};

const normalizeSmartExtraction = (payload) => {
  const source = payload?.fields && typeof payload.fields === 'object' ? payload.fields : payload || {};
  const categoryCandidate = cleanSmartString(source.category);
  const category = categoryCandidate && SMART_EXTRACTION_CATEGORIES.has(categoryCandidate) ? categoryCandidate : null;
  const fields = {
    itemNumber: cleanSmartString(source.itemNumber),
    barcode: cleanSmartString(source.barcode),
    name: cleanSmartString(source.name),
    category,
    brand: cleanSmartString(source.brand),
    model: cleanSmartString(source.model),
    serialNumber: cleanSmartString(source.serialNumber),
    purchaseDate: cleanSmartDate(source.purchaseDate),
    purchaseValue: cleanSmartNumber(source.purchaseValue),
    vatRate: cleanSmartNumber(source.vatRate),
    vatAmount: cleanSmartNumber(source.vatAmount),
    purchaseValueBeforeVat: cleanSmartNumber(source.purchaseValueBeforeVat),
    purchaseValueIncludingVat: cleanSmartNumber(source.purchaseValueIncludingVat),
    department: cleanSmartString(source.department),
    building: cleanSmartString(source.building),
    floor: cleanSmartString(source.floor),
    room: cleanSmartString(source.room),
    manufacturer: cleanSmartString(source.manufacturer),
    entityName: cleanSmartString(source.entityName),
    region: cleanSmartString(source.region),
    city: cleanSmartString(source.city),
    assetDescription: cleanSmartString(source.assetDescription),
    supplier: cleanSmartString(source.supplier),
    invoiceNumber: cleanSmartString(source.invoiceNumber),
    currency: cleanSmartString(source.currency),
  };
  const confidenceRaw = Number(payload?.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : null;
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings.map(cleanSmartString).filter(Boolean).slice(0, 10) : [];
  return { fields, confidence, warnings, summary: cleanSmartString(payload?.summary) };
};

const nullableText = z.string().trim().max(5000).optional().nullable();
const nullableShortText = z.string().trim().max(500).optional().nullable();
const nullableNumber = z.coerce.number().min(0).optional().nullable();
const dateType = z.enum(['gregorian', 'hijri']).optional().default('gregorian');

const attachmentSchema = z.object({
  title: z.string().trim().min(1).max(500),
  driveUrl: z.string().url(),
  driveFileId: nullableShortText,
  mimeType: nullableShortText,
  notes: nullableShortText,
});

const assetSchema = z.object({
  itemNumber: z.string().trim().min(1, 'رقم الصنف مطلوب').max(150),
  barcode: nullableShortText,
  name: z.string().trim().min(1, 'اسم الأصل مطلوب').max(300),
  category: z.string().trim().min(1, 'تصنيف الأصل مطلوب').max(100),
  brand: nullableShortText,
  model: nullableShortText,
  serialNumber: nullableShortText,
  status: z.string().trim().max(100).default('available'),
  technicalCondition: nullableShortText,
  department: nullableShortText,
  building: nullableShortText,
  floor: nullableShortText,
  room: nullableShortText,
  entityName: nullableShortText,
  entityCode: nullableShortText,
  assetDescription: nullableText,
  cardNumber: nullableShortText,
  responsibleDepartment: nullableShortText,
  region: nullableShortText,
  city: nullableShortText,
  buildingNumber: nullableShortText,
  coordinates: nullableShortText,
  classification1: nullableShortText,
  classification2: nullableShortText,
  classification3: nullableShortText,
  classification4: nullableShortText,
  classification5: nullableShortText,
  classification6: nullableShortText,
  accountingGroup: nullableShortText,
  accountingGroupCode: nullableShortText,
  assetCode: nullableShortText,
  remainingLife: nullableNumber,
  usefulLife: nullableNumber,
  purchaseDate: z.string().trim().optional().nullable(),
  purchaseDateType: dateType,
  purchaseValue: nullableNumber,
  vatRate: z.coerce.number().min(0).max(100).optional().nullable().default(15),
  vatAmount: nullableNumber,
  purchaseValueBeforeVat: nullableNumber,
  purchaseValueIncludingVat: nullableNumber,
  serviceDate: z.string().trim().optional().nullable(),
  serviceDateType: dateType,
  acquisitionCost: nullableNumber,
  supportingCostDocument: nullableShortText,
  archiveDocumentNumber: nullableShortText,
  manufacturer: nullableShortText,
  lastInventoryDate: z.string().trim().optional().nullable(),
  lastInventoryDateType: dateType,
  unitOfMeasure: nullableShortText,
  quantity: z.coerce.number().min(0, 'العدد لا يمكن أن يكون أقل من صفر').optional().nullable().default(1),
  excelPayload: z.record(z.string(), z.any()).optional().nullable(),
  notes: nullableText,
  attachments: z.array(attachmentSchema).default([]),
});

const transferSchema = z.object({
  toDepartment: z.string().trim().min(1, 'الجهة / الإدارة الجديدة مطلوبة').max(500),
  toBuilding: nullableShortText,
  toFloor: nullableShortText,
  toRoom: nullableShortText,
  reason: nullableText,
  notes: nullableText,
});

const inventorySchema = z.object({
  method: z.enum(['barcode', 'camera', 'manual']),
  scannedBarcode: nullableShortText,
  result: z.string().trim().max(100).optional().default('matched'),
  department: nullableShortText,
  building: nullableShortText,
  floor: nullableShortText,
  room: nullableShortText,
  notes: nullableText,
});

const lossCaseSchema = z.object({
  caseNumber: z.string().trim().min(1, 'رقم المحضر مطلوب').max(150),
  minutesNumber: nullableShortText,
  minutesDate: z.string().trim().optional().nullable(),
  minutesDateType: dateType,
  department: nullableShortText,
  reason: z.string().trim().min(1, 'سبب العجز / الفقد مطلوب').max(5000),
  assetValue: nullableNumber,
  actionTaken: nullableText,
  notes: nullableText,
});

const toDate = (value, fieldName, type = 'gregorian') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (!match) {
      const error = new Error(`${fieldName} الهجري غير صحيح`);
      error.status = 400;
      throw error;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 30) {
      const error = new Error(`${fieldName} الهجري غير صحيح`);
      error.status = 400;
      throw error;
    }
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName} الميلادي غير صحيح`);
    error.status = 400;
    throw error;
  }
  return parsed;
};

const nextBarcode = async () => {
  const year = new Date().getFullYear();
  const prefix = `IAU-AST-${year}-`;
  const latest = await prisma.asset.findFirst({
    where: { barcode: { startsWith: prefix } },
    orderBy: { barcode: 'desc' },
    select: { barcode: true },
  });
  const last = latest?.barcode ? Number(String(latest.barcode).split('-').pop() || 0) : 0;
  return `${prefix}${String(last + 1).padStart(7, '0')}`;
};

const withAttachments = async (records) => {
  if (!records.length) return records;
  const attachments = await prisma.attachment.findMany({
    where: { entityType: 'asset', entityId: { in: records.map((record) => record.id) } },
    orderBy: { createdAt: 'desc' },
  });
  const grouped = new Map();
  for (const attachment of attachments) {
    const list = grouped.get(attachment.entityId) || [];
    list.push(attachment);
    grouped.set(attachment.entityId, list);
  }
  return records.map((record) => ({ ...record, attachments: grouped.get(record.id) || [] }));
};

const createAttachmentData = (attachment, assetId, createdBy) => ({
  entityType: 'asset',
  entityId: assetId,
  attachmentType: 'other',
  title: attachment.title,
  driveUrl: attachment.driveUrl,
  driveFileId: attachment.driveFileId || null,
  mimeType: attachment.mimeType || null,
  notes: attachment.notes || null,
  createdBy: createdBy || null,
});

const normalizeAssetData = (input, { barcode, purchaseDate, serviceDate, lastInventoryDate }) => ({
  assetNumber: input.itemNumber,
  itemNumber: input.itemNumber,
  barcode,
  name: input.name,
  category: input.category,
  brand: input.brand || null,
  model: input.model || null,
  serialNumber: input.serialNumber || null,
  status: input.status || 'available',
  technicalCondition: input.technicalCondition || null,
  department: input.department || input.responsibleDepartment || input.entityName || null,
  building: input.building || input.buildingNumber || null,
  floor: input.floor || null,
  room: input.room || null,
  custodian: null,
  entityName: input.entityName || input.department || null,
  entityCode: input.entityCode || null,
  assetDescription: input.assetDescription || null,
  cardNumber: input.cardNumber || null,
  responsibleDepartment: input.responsibleDepartment || input.department || null,
  region: input.region || null,
  city: input.city || null,
  buildingNumber: input.buildingNumber || input.building || null,
  coordinates: input.coordinates || null,
  classification1: input.classification1 || null,
  classification2: input.classification2 || null,
  classification3: input.classification3 || null,
  classification4: input.classification4 || null,
  classification5: input.classification5 || null,
  classification6: input.classification6 || null,
  accountingGroup: input.accountingGroup || null,
  accountingGroupCode: input.accountingGroupCode || null,
  assetCode: input.assetCode || null,
  remainingLife: input.remainingLife ?? null,
  usefulLife: input.usefulLife ?? null,
  purchaseDate,
  purchaseDateType: input.purchaseDateType,
  purchaseValue: input.purchaseValue ?? input.purchaseValueBeforeVat ?? null,
  vatRate: input.vatRate ?? 15,
  vatAmount: input.vatAmount ?? ((input.purchaseValueBeforeVat ?? input.purchaseValue) == null ? null : Math.round((((input.purchaseValueBeforeVat ?? input.purchaseValue) * (input.vatRate ?? 15) / 100) + Number.EPSILON) * 100) / 100),
  purchaseValueBeforeVat: input.purchaseValueBeforeVat ?? input.purchaseValue ?? null,
  purchaseValueIncludingVat: input.purchaseValueIncludingVat ?? ((input.purchaseValueBeforeVat ?? input.purchaseValue) == null ? null : Math.round((((input.purchaseValueBeforeVat ?? input.purchaseValue) * (1 + (input.vatRate ?? 15) / 100)) + Number.EPSILON) * 100) / 100),
  serviceDate,
  serviceDateType: input.serviceDateType,
  acquisitionCost: input.acquisitionCost ?? input.purchaseValue ?? null,
  supportingCostDocument: input.supportingCostDocument || null,
  archiveDocumentNumber: input.archiveDocumentNumber || null,
  manufacturer: input.manufacturer || input.brand || null,
  lastInventoryDate,
  lastInventoryDateType: input.lastInventoryDateType,
  unitOfMeasure: input.unitOfMeasure || null,
  quantity: input.quantity ?? 1,
  excelPayload: input.excelPayload || null,
  notes: input.notes || null,
});

router.get('/excel-template', async (_req, res, next) => {
  try {
    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });
    res.json(template || null);
  } catch (error) { next(error); }
});

router.post('/excel-template', officialExcelTemplateUpload.single('file'), async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'admin') return res.status(403).json({ message: 'رفع أو استبدال قالب Excel الرسمي متاح لمسؤول النظام فقط.' });
    if (!req.file) return res.status(400).json({ message: 'لم يتم إرفاق قالب Excel.' });
    const previous = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });
    const uploaded = await uploadBufferToGoogleDrive(req.file, { fileName: 'official-assets-template.xlsx', mimeType: EXCEL_MIME });
    const uploadedBy = req.authUser?.username || req.authUser?.email || null;
    const template = await prisma.assetExcelTemplate.upsert({
      where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY },
      update: { title: 'نموذج الأصول الرسمي المعتمد', fileName: req.file.originalname || uploaded.fileName, driveFileId: uploaded.driveFileId, driveUrl: uploaded.driveUrl, mimeType: uploaded.mimeType || EXCEL_MIME, fileSize: req.file.size || null, uploadedBy },
      create: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY, title: 'نموذج الأصول الرسمي المعتمد', fileName: req.file.originalname || uploaded.fileName, driveFileId: uploaded.driveFileId, driveUrl: uploaded.driveUrl, mimeType: uploaded.mimeType || EXCEL_MIME, fileSize: req.file.size || null, uploadedBy },
    });
    if (previous?.driveFileId && previous.driveFileId !== uploaded.driveFileId) {
      deleteGoogleDriveFile(previous.driveFileId).catch((error) => console.warn('Could not delete previous asset Excel template:', error?.message || error));
    }
    await createAuditLog({ user: req.authUser, action: previous ? 'update' : 'create', module: 'assets', entity: 'asset_excel_template', entityId: template.id, entityLabel: template.fileName, description: previous ? 'استبدال قالب Excel الرسمي للأصول' : 'رفع قالب Excel الرسمي للأصول', newData: template, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(previous ? 200 : 201).json(template);
  } catch (error) { next(error); }
});

router.get('/excel-template/file', async (_req, res, next) => {
  try {
    const template = await prisma.assetExcelTemplate.findUnique({ where: { templateKey: OFFICIAL_ASSET_TEMPLATE_KEY } });
    if (!template) return res.status(404).json({ message: 'لم يتم رفع قالب Excel الرسمي للأصول بعد.' });
    const downloaded = await downloadGoogleDriveFile(template.driveFileId);
    const safeName = String(template.fileName || downloaded.fileName || 'official-assets-template.xlsx').replace(/[\"\r\n]/g, '_');
    res.setHeader('Content-Type', EXCEL_MIME);
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(safeName));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(downloaded.buffer);
  } catch (error) { next(error); }
});

router.post('/extract-data', smartExtractionUpload.fields([{ name: 'files', maxCount: 8 }, { name: 'file', maxCount: 1 }]), async (req, res, next) => {
  try {
    const moduleKey = String(req.body?.module || 'asset').trim();
    const moduleSpec = moduleKey === 'asset' ? null : SMART_EXTRACTION_MODULES[moduleKey];
    if (moduleKey !== 'asset' && !moduleSpec) return res.status(400).json({ message: 'نوع السجل المطلوب للاستخراج الذكي غير مدعوم.' });
    const smartFiles = [
      ...((req.files?.files || [])),
      ...((req.files?.file || [])),
    ].slice(0, 8);
    if (!smartFiles.length) return res.status(400).json({ message: 'اختر صورة أو ملف PDF واحدًا على الأقل للاستخراج الذكي.' });
    const totalSize = smartFiles.reduce((sum, file) => sum + Number(file.size || file.buffer?.length || 0), 0);
    if (totalSize > 40 * 1024 * 1024) return res.status(400).json({ message: 'إجمالي ملفات القراءة يتجاوز 40MB. قلّل عدد الصفحات أو أحجام الملفات.' });

    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(503).json({
        message: 'ميزة الاستخراج الذكي جاهزة في النظام، لكن يلزم تفعيل OPENAI_API_KEY في إعدادات Backend على Railway.',
      });
    }

    const fileInputs = smartFiles.map((file, index) => {
      const mimeType = file.mimetype || (/\.pdf$/i.test(file.originalname || '') ? 'application/pdf' : 'image/jpeg');
      const base64 = file.buffer.toString('base64');
      return mimeType === 'application/pdf'
        ? { type: 'input_file', filename: file.originalname || `asset-document-${index + 1}.pdf`, file_data: base64 }
        : { type: 'input_image', image_url: `data:${mimeType};base64,${base64}`, detail: 'high' };
    });

    const assetExtractionPrompt = [
      'أنت نظام استخراج بيانات أصول لجامعة الإمام عبدالرحمن بن فيصل.',
      'اقرأ جميع الصور والمستندات المرفقة بدقة باعتبارها صفحات أو مستندات مرتبطة بنفس عملية إدخال الأصل. اربط المعلومات المتكاملة بين الصفحات، واستخرج فقط المعلومات الظاهرة أو المدعومة بوضوح. لا تخمّن أرقاماً أو قيماً غير موجودة.',
      'أعد JSON صالحاً فقط بدون Markdown بالشكل: {"fields":{...},"confidence":0.0,"warnings":[],"summary":""}.',
      'الحقول المسموحة داخل fields: itemNumber, barcode, name, category, brand, model, serialNumber, purchaseDate, purchaseValue, vatRate, vatAmount, purchaseValueBeforeVat, purchaseValueIncludingVat, department, building, floor, room, manufacturer, entityName, region, city, assetDescription, supplier, invoiceNumber, currency.',
      'purchaseDate يجب أن يكون YYYY-MM-DD إن أمكن. purchaseValue وpurchaseValueBeforeVat يمثلان القيمة قبل الضريبة إن ظهرت بوضوح، vatRate نسبة الضريبة، vatAmount قيمة الضريبة، وpurchaseValueIncludingVat الإجمالي شامل الضريبة. جميع القيم المالية أرقام فقط دون رمز العملة.',
      'النسبة الأساسية الحالية لضريبة القيمة المضافة في المملكة العربية السعودية هي 15%. إذا لم تظهر الضريبة بوضوح في المستند فلا تخمّن أنها مطبقة؛ أعد الحقول الضريبية null وسيطبق النظام النسبة الأساسية افتراضيًا عند الإدخال.',
      'category يجب أن تكون قيمة واحدة فقط من: it لتقنية المعلومات، furniture للأثاث، equipment للأجهزة والمعدات، vehicle للمركبات، land للأراضي، other لأي تصنيف آخر.',
      'إذا لم يظهر الحقل بثقة ضع null. استخرج اسم الصنف والمبلغ والماركة والموديل والرقم التسلسلي والباركود والجهة والموقع من الفواتير أو ملصقات الأصول بقدر المستطاع.',
      'confidence رقم من 0 إلى 1 يعكس ثقتك العامة، وwarnings ملاحظات قصيرة عند وجود غموض.',
    ].join('\n');
    const extractionPrompt = moduleKey === 'asset' ? assetExtractionPrompt : buildGenericExtractionPrompt(moduleSpec);

    const smartExtractionModel = String(process.env.OPENAI_SMART_EXTRACTION_MODEL || process.env.OPENAI_ASSET_EXTRACTION_MODEL || 'gpt-5-mini').trim();
    const openAiRequestBody = {
      model: smartExtractionModel,
      input: [{ role: 'user', content: [{ type: 'input_text', text: extractionPrompt }, ...fileInputs] }],
      text: { format: { type: 'json_object' } },
      max_output_tokens: 4000,
      store: false,
    };
    if (/^(gpt-5|o1|o3|o4)/i.test(smartExtractionModel)) {
      openAiRequestBody.reasoning = { effort: 'low' };
    }

    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(openAiRequestBody),
    });

    const openAiPayload = await openAiResponse.json().catch(() => ({}));
    if (!openAiResponse.ok) {
      console.error('Asset smart extraction failed:', openAiPayload?.error?.message || openAiResponse.statusText);
      return res.status(502).json({ message: 'تعذر تحليل الملف حاليًا بواسطة خدمة الاستخراج الذكي. حاول مرة أخرى بعد قليل.' });
    }

    const outputText = responseOutputText(openAiPayload);
    if (!outputText) {
      console.error('Asset smart extraction returned no output text:', {
        status: openAiPayload?.status || null,
        incompleteDetails: openAiPayload?.incomplete_details || null,
        model: smartExtractionModel,
        usage: openAiPayload?.usage || null,
      });
      const message = openAiPayload?.status === 'incomplete'
        ? 'توقف التحليل قبل اكتمال استخراج البيانات. أعد المحاولة، أو قلّل عدد الصفحات في العملية الواحدة.'
        : 'لم تُرجع خدمة الاستخراج الذكي بيانات قابلة للقراءة. حاول مرة أخرى.';
      return res.status(502).json({ message });
    }

    let parsed;
    try {
      parsed = parseSmartExtractionJson(outputText);
    } catch (parseError) {
      console.error('Asset smart extraction JSON parse failed:', {
        message: parseError?.message || String(parseError),
        status: openAiPayload?.status || null,
        model: smartExtractionModel,
        outputPreview: outputText.slice(0, 500),
      });
      return res.status(502).json({ message: 'تعذر تنظيم البيانات المستخرجة من المستند. أعد المحاولة.' });
    }
    const normalized = moduleKey === 'asset' ? normalizeSmartExtraction(parsed) : normalizeGenericSmartExtraction(parsed, moduleSpec);
    res.json({
      ...normalized,
      module: moduleKey,
      source: {
        fileName: smartFiles.length === 1 ? (smartFiles[0].originalname || 'asset-document') : `${smartFiles.length} files`,
        mimeType: smartFiles.length === 1 ? (smartFiles[0].mimetype || null) : 'multipart/mixed',
        size: totalSize,
        files: smartFiles.map((file) => ({
          fileName: file.originalname || 'asset-document',
          mimeType: file.mimetype || null,
          size: file.size || file.buffer.length,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/stats', async (_req, res, next) => {
  try {
    const [total, available, inUse, maintenance, lost, disposed, inventoryCount] = await Promise.all([
      prisma.asset.count(),
      prisma.asset.count({ where: { status: { in: ['available', 'active', 'stored'] } } }),
      prisma.asset.count({ where: { status: { in: ['in_use', 'assigned'] } } }),
      prisma.asset.count({ where: { status: 'maintenance' } }),
      prisma.asset.count({ where: { status: { in: ['lost', 'damaged'] } } }),
      prisma.asset.count({ where: { status: 'disposed' } }),
      prisma.assetInventoryEvent.count(),
    ]);
    res.json({ total, available, inUse, maintenance, lost, disposed, inventoryCount });
  } catch (error) {
    next(error);
  }
});

router.get('/lookup/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    const record = await prisma.asset.findFirst({
      where: { OR: [{ barcode: code }, { itemNumber: code }, { assetNumber: code }] },
    });
    if (!record) return res.status(404).json({ message: 'لم يتم العثور على أصل بهذا الرقم أو الباركود' });
    const [result] = await withAttachments([record]);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    const status = String(req.query.status || '').trim();
    const where = {
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(search ? {
        OR: [
          { itemNumber: { contains: search, mode: 'insensitive' } },
          { assetNumber: { contains: search, mode: 'insensitive' } },
          { barcode: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { serialNumber: { contains: search, mode: 'insensitive' } },
          { department: { contains: search, mode: 'insensitive' } },
          { building: { contains: search, mode: 'insensitive' } },
          { room: { contains: search, mode: 'insensitive' } },
          { responsibleDepartment: { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const records = await prisma.asset.findMany({ where, orderBy: [{ createdAt: 'desc' }] });
    res.json(await withAttachments(records));
  } catch (error) {
    next(error);
  }
});

router.get('/:id/movements', async (req, res, next) => {
  try {
    res.json(await prisma.assetMovement.findMany({ where: { assetId: req.params.id }, orderBy: { movedAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.post('/:id/transfer', async (req, res, next) => {
  try {
    const input = transferSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const movedBy = req.authUser?.username || req.authUser?.email || null;
    const result = await prisma.$transaction(async (tx) => {
      const movement = await tx.assetMovement.create({
        data: {
          assetId: existing.id,
          fromDepartment: existing.department,
          fromBuilding: existing.building,
          fromFloor: existing.floor,
          fromRoom: existing.room,
          toDepartment: input.toDepartment,
          toBuilding: input.toBuilding || null,
          toFloor: input.toFloor || null,
          toRoom: input.toRoom || null,
          reason: input.reason || null,
          notes: input.notes || null,
          movedBy,
        },
      });
      const asset = await tx.asset.update({
        where: { id: existing.id },
        data: {
          department: input.toDepartment,
          responsibleDepartment: input.toDepartment,
          entityName: input.toDepartment,
          building: input.toBuilding || null,
          buildingNumber: input.toBuilding || null,
          floor: input.toFloor || null,
          room: input.toRoom || null,
        },
      });
      return { movement, asset };
    });
    await createAuditLog({ user: req.authUser, action: 'transfer', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: 'نقل أصل بين المواقع / الجهات', previousData: existing, newData: result.asset, details: result.movement, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.get('/:id/inventory', async (req, res, next) => {
  try {
    res.json(await prisma.assetInventoryEvent.findMany({ where: { assetId: req.params.id }, orderBy: { scannedAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.post('/:id/inventory', async (req, res, next) => {
  try {
    const input = inventorySchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const scannedBy = req.authUser?.username || req.authUser?.email || null;
    const event = await prisma.$transaction(async (tx) => {
      const created = await tx.assetInventoryEvent.create({ data: {
        assetId: existing.id,
        method: input.method,
        scannedBarcode: input.scannedBarcode || null,
        result: input.result || 'matched',
        department: input.department || existing.department,
        building: input.building || existing.building,
        floor: input.floor || existing.floor,
        room: input.room || existing.room,
        notes: input.notes || null,
        scannedBy,
      } });
      await tx.asset.update({ where: { id: existing.id }, data: { lastInventoryDate: new Date(), lastInventoryDateType: 'gregorian' } });
      return created;
    });
    await createAuditLog({ user: req.authUser, action: 'inventory', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: `جرد أصل بواسطة ${input.method}`, newData: event, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(event);
  } catch (error) { next(error); }
});

router.get('/:id/loss-cases', async (req, res, next) => {
  try { res.json(await prisma.assetLossCase.findMany({ where: { assetId: req.params.id }, orderBy: { createdAt: 'desc' } })); }
  catch (error) { next(error); }
});

router.post('/:id/loss-cases', async (req, res, next) => {
  try {
    const input = lossCaseSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const createdBy = req.authUser?.username || req.authUser?.email || null;
    const caseRecord = await prisma.$transaction(async (tx) => {
      const created = await tx.assetLossCase.create({ data: {
        assetId: existing.id,
        caseNumber: input.caseNumber,
        minutesNumber: input.minutesNumber || null,
        minutesDate: toDate(input.minutesDate, 'تاريخ المحضر', input.minutesDateType),
        minutesDateType: input.minutesDateType,
        department: input.department || existing.department,
        reason: input.reason,
        assetValue: input.assetValue ?? existing.acquisitionCost ?? existing.purchaseValue ?? null,
        actionTaken: input.actionTaken || null,
        notes: input.notes || null,
        createdBy,
      } });
      await tx.asset.update({ where: { id: existing.id }, data: { status: 'lost' } });
      return created;
    });
    await createAuditLog({ user: req.authUser, action: 'create', module: 'assets', entity: 'asset_loss_case', entityId: caseRecord.id, entityLabel: input.caseNumber, description: 'تسجيل عجز / فقد على أصل', newData: caseRecord, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(caseRecord);
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ message: 'الأصل غير موجود' });
    const [result] = await withAttachments([record]);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = assetSchema.parse(req.body);
    const duplicate = await prisma.asset.findUnique({ where: { itemNumber: input.itemNumber } });
    if (duplicate) return res.status(409).json({ message: 'رقم الصنف مستخدم مسبقًا ويجب أن يكون فريدًا' });
    let barcode = input.barcode?.trim() || '';
    if (!barcode) barcode = await nextBarcode();
    const barcodeDuplicate = await prisma.asset.findUnique({ where: { barcode } });
    if (barcodeDuplicate) return res.status(409).json({ message: 'الباركود مستخدم مسبقًا' });

    const purchaseDate = toDate(input.purchaseDate, 'تاريخ الشراء', input.purchaseDateType);
    const serviceDate = toDate(input.serviceDate, 'تاريخ الدخول في الخدمة', input.serviceDateType);
    const lastInventoryDate = toDate(input.lastInventoryDate, 'تاريخ الجرد', input.lastInventoryDateType);

    const createdBy = req.authUser?.username || req.authUser?.email || null;
    const result = await prisma.$transaction(async (tx) => {
      const record = await tx.asset.create({ data: normalizeAssetData(input, { barcode, purchaseDate, serviceDate, lastInventoryDate }) });
      if (input.attachments.length) {
        await tx.attachment.createMany({ data: input.attachments.map((attachment) => createAttachmentData(attachment, record.id, createdBy)) });
      }
      return record;
    });
    const [withFiles] = await withAttachments([result]);
    await createAuditLog({ user: req.authUser, action: 'create', module: 'assets', entity: 'asset', entityId: result.id, entityLabel: result.itemNumber || result.assetNumber, description: 'إضافة أصل جديد', newData: withFiles, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json(withFiles);
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const input = assetSchema.parse(req.body);
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const duplicate = await prisma.asset.findFirst({ where: { itemNumber: input.itemNumber, NOT: { id: existing.id } } });
    if (duplicate) return res.status(409).json({ message: 'رقم الصنف مستخدم مسبقًا ويجب أن يكون فريدًا' });
    let barcode = input.barcode?.trim() || existing.barcode || '';
    if (!barcode) barcode = await nextBarcode();
    const barcodeDuplicate = await prisma.asset.findFirst({ where: { barcode, NOT: { id: existing.id } } });
    if (barcodeDuplicate) return res.status(409).json({ message: 'الباركود مستخدم مسبقًا' });

    const purchaseDate = toDate(input.purchaseDate, 'تاريخ الشراء', input.purchaseDateType);
    const serviceDate = toDate(input.serviceDate, 'تاريخ الدخول في الخدمة', input.serviceDateType);
    const lastInventoryDate = toDate(input.lastInventoryDate, 'تاريخ الجرد', input.lastInventoryDateType);
    const createdBy = req.authUser?.username || req.authUser?.email || null;
    const result = await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({ where: { entityType: 'asset', entityId: existing.id } });
      const updateData = normalizeAssetData(input, { barcode, purchaseDate, serviceDate, lastInventoryDate });
      // createdAt is the immutable first-entry timestamp. Never allow edits/import refreshes to change it.
      const record = await tx.asset.update({ where: { id: existing.id }, data: { ...updateData, createdAt: existing.createdAt } });
      if (input.attachments.length) {
        await tx.attachment.createMany({ data: input.attachments.map((attachment) => createAttachmentData(attachment, record.id, createdBy)) });
      }
      return record;
    });
    const [withFiles] = await withAttachments([result]);
    await createAuditLog({ user: req.authUser, action: 'update', module: 'assets', entity: 'asset', entityId: result.id, entityLabel: result.itemNumber || result.assetNumber, description: 'تعديل بيانات أصل', previousData: existing, newData: withFiles, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.json(withFiles);
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'الأصل غير موجود' });
    const deletedBy = req.authUser?.username || req.authUser?.email || null;
    await prisma.$transaction([
      prisma.assetMovement.deleteMany({ where: { assetId: existing.id } }),
      prisma.assetInventoryEvent.deleteMany({ where: { assetId: existing.id } }),
      prisma.assetLossCase.deleteMany({ where: { assetId: existing.id } }),
      prisma.attachment.deleteMany({ where: { entityType: 'asset', entityId: existing.id } }),
      prisma.asset.delete({ where: { id: existing.id } }),
    ]);
    await createAuditLog({ user: req.authUser, action: 'delete', module: 'assets', entity: 'asset', entityId: existing.id, entityLabel: existing.itemNumber || existing.assetNumber, description: 'حذف أصل مع الاحتفاظ بسجل العملية وبياناته السابقة في سجل العمليات', previousData: existing, ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });
    res.status(204).end();
  } catch (error) { next(error); }
});

export default router;
