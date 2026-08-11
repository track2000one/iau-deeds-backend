const fs = require('fs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(before, after);
}

const path = 'src/routes/assets.routes.js';
let src = fs.readFileSync(path, 'utf8');

const helperBlock = `const smartExtractionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const fileName = String(file.originalname || '').toLowerCase();
    const allowed = file.mimetype?.startsWith('image/') || file.mimetype === 'application/pdf' || fileName.endsWith('.pdf');
    cb(allowed ? null : new Error('الاستخراج الذكي يدعم الصور وملفات PDF فقط.'), allowed);
  },
});

const SMART_EXTRACTION_CATEGORIES = new Set(['it', 'furniture', 'equipment', 'vehicle', 'land', 'other']);

const cleanSmartString = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 1000) : null;
};

const cleanSmartNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/[^0-9.\\-]/g, ''));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
};

const cleanSmartDate = (value) => {
  const text = cleanSmartString(value);
  if (!text) return null;
  const exact = text.match(/^\\d{4}-\\d{2}-\\d{2}$/)?.[0];
  if (exact) return exact;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const parseSmartExtractionJson = (text) => {
  const raw = String(text || '').trim().replace(/^\\\`\\\`\\\`(?:json)?/i, '').replace(/\\\`\\\`\\\`$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('لم تُرجع خدمة الاستخراج بيانات منظمة قابلة للقراءة.');
  return JSON.parse(raw.slice(start, end + 1));
};

const responseOutputText = (payload) => {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
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

`;

src = replaceOnce(
  src,
  "const nullableText = z.string().trim().max(5000).optional().nullable();",
  helperBlock + "const nullableText = z.string().trim().max(5000).optional().nullable();",
  'smart extraction helpers'
);

const routeBlock = `router.post('/extract-data', smartExtractionUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'اختر صورة أو ملف PDF لاستخراج بيانات الأصل.' });

    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(503).json({
        message: 'ميزة الاستخراج الذكي جاهزة في النظام، لكن يلزم تفعيل OPENAI_API_KEY في إعدادات Backend على Railway.',
      });
    }

    const mimeType = req.file.mimetype || (/\\.pdf$/i.test(req.file.originalname || '') ? 'application/pdf' : 'image/jpeg');
    const base64 = req.file.buffer.toString('base64');
    const fileInput = mimeType === 'application/pdf'
      ? { type: 'input_file', filename: req.file.originalname || 'asset-document.pdf', file_data: base64 }
      : { type: 'input_image', image_url: \`data:\${mimeType};base64,\${base64}\`, detail: 'high' };

    const extractionPrompt = [
      'أنت نظام استخراج بيانات أصول لجامعة الإمام عبدالرحمن بن فيصل.',
      'اقرأ الصورة أو المستند المرفق بدقة واستخرج فقط المعلومات الظاهرة أو المدعومة بوضوح. لا تخمّن أرقاماً أو قيماً غير موجودة.',
      'أعد JSON صالحاً فقط بدون Markdown بالشكل: {"fields":{...},"confidence":0.0,"warnings":[],"summary":""}.',
      'الحقول المسموحة داخل fields: itemNumber, barcode, name, category, brand, model, serialNumber, purchaseDate, purchaseValue, department, building, floor, room, manufacturer, entityName, region, city, assetDescription, supplier, invoiceNumber, currency.',
      'purchaseDate يجب أن يكون YYYY-MM-DD إن أمكن، وpurchaseValue رقم فقط دون رمز العملة.',
      'category يجب أن تكون قيمة واحدة فقط من: it لتقنية المعلومات، furniture للأثاث، equipment للأجهزة والمعدات، vehicle للمركبات، land للأراضي، other لأي تصنيف آخر.',
      'إذا لم يظهر الحقل بثقة ضع null. استخرج اسم الصنف والمبلغ والماركة والموديل والرقم التسلسلي والباركود والجهة والموقع من الفواتير أو ملصقات الأصول بقدر المستطاع.',
      'confidence رقم من 0 إلى 1 يعكس ثقتك العامة، وwarnings ملاحظات قصيرة عند وجود غموض.',
    ].join('\\n');

    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: \`Bearer \${apiKey}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: String(process.env.OPENAI_ASSET_EXTRACTION_MODEL || 'gpt-5-mini'),
        input: [{ role: 'user', content: [{ type: 'input_text', text: extractionPrompt }, fileInput] }],
        max_output_tokens: 1800,
      }),
    });

    const openAiPayload = await openAiResponse.json().catch(() => ({}));
    if (!openAiResponse.ok) {
      console.error('Asset smart extraction failed:', openAiPayload?.error?.message || openAiResponse.statusText);
      return res.status(502).json({ message: 'تعذر تحليل الملف حاليًا بواسطة خدمة الاستخراج الذكي. حاول مرة أخرى بعد قليل.' });
    }

    const parsed = parseSmartExtractionJson(responseOutputText(openAiPayload));
    const normalized = normalizeSmartExtraction(parsed);
    res.json({
      ...normalized,
      source: {
        fileName: req.file.originalname || 'asset-document',
        mimeType,
        size: req.file.size || req.file.buffer.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

`;

src = replaceOnce(
  src,
  "router.get('/stats', async (_req, res, next) => {",
  routeBlock + "router.get('/stats', async (_req, res, next) => {",
  'smart extraction route'
);

fs.writeFileSync(path, src);
console.log('Asset smart extraction backend patch applied.');
