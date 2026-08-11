const fs = require('fs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(before, after);
}

// Prisma schema
{
  const path = 'prisma/schema.prisma';
  let s = fs.readFileSync(path, 'utf8');
  s = replaceOnce(
    s,
    "  purchaseValue         Float?\n  serviceDate           DateTime?",
    "  purchaseValue         Float?\n  vatRate               Float?    @default(15)\n  vatAmount             Float?\n  purchaseValueBeforeVat Float?\n  purchaseValueIncludingVat Float?\n  serviceDate           DateTime?",
    'Asset VAT database fields'
  );
  fs.writeFileSync(path, s);
}

// Asset routes
{
  const path = 'src/routes/assets.routes.js';
  let s = fs.readFileSync(path, 'utf8');

  s = replaceOnce(
    s,
    "    purchaseValue: cleanSmartNumber(source.purchaseValue),\n    department: cleanSmartString(source.department),",
    "    purchaseValue: cleanSmartNumber(source.purchaseValue),\n    vatRate: cleanSmartNumber(source.vatRate),\n    vatAmount: cleanSmartNumber(source.vatAmount),\n    purchaseValueBeforeVat: cleanSmartNumber(source.purchaseValueBeforeVat),\n    purchaseValueIncludingVat: cleanSmartNumber(source.purchaseValueIncludingVat),\n    department: cleanSmartString(source.department),",
    'smart extraction VAT normalization'
  );

  s = replaceOnce(
    s,
    "  purchaseValue: nullableNumber,\n  serviceDate:",
    "  purchaseValue: nullableNumber,\n  vatRate: z.coerce.number().min(0).max(100).optional().nullable().default(15),\n  vatAmount: nullableNumber,\n  purchaseValueBeforeVat: nullableNumber,\n  purchaseValueIncludingVat: nullableNumber,\n  serviceDate:",
    'asset schema VAT fields'
  );

  s = replaceOnce(
    s,
    "  purchaseValue: input.purchaseValue ?? null,\n  serviceDate,",
    "  purchaseValue: input.purchaseValue ?? input.purchaseValueBeforeVat ?? null,\n  vatRate: input.vatRate ?? 15,\n  vatAmount: input.vatAmount ?? ((input.purchaseValueBeforeVat ?? input.purchaseValue) == null ? null : Math.round((((input.purchaseValueBeforeVat ?? input.purchaseValue) * (input.vatRate ?? 15) / 100) + Number.EPSILON) * 100) / 100),\n  purchaseValueBeforeVat: input.purchaseValueBeforeVat ?? input.purchaseValue ?? null,\n  purchaseValueIncludingVat: input.purchaseValueIncludingVat ?? ((input.purchaseValueBeforeVat ?? input.purchaseValue) == null ? null : Math.round((((input.purchaseValueBeforeVat ?? input.purchaseValue) * (1 + (input.vatRate ?? 15) / 100)) + Number.EPSILON) * 100) / 100),\n  serviceDate,",
    'normalize VAT fields'
  );

  s = replaceOnce(
    s,
    "      'الحقول المسموحة داخل fields: itemNumber, barcode, name, category, brand, model, serialNumber, purchaseDate, purchaseValue, department, building, floor, room, manufacturer, entityName, region, city, assetDescription, supplier, invoiceNumber, currency.',",
    "      'الحقول المسموحة داخل fields: itemNumber, barcode, name, category, brand, model, serialNumber, purchaseDate, purchaseValue, vatRate, vatAmount, purchaseValueBeforeVat, purchaseValueIncludingVat, department, building, floor, room, manufacturer, entityName, region, city, assetDescription, supplier, invoiceNumber, currency.',",
    'smart extraction allowed VAT fields'
  );

  s = replaceOnce(
    s,
    "      'purchaseDate يجب أن يكون YYYY-MM-DD إن أمكن، وpurchaseValue رقم فقط دون رمز العملة.',",
    "      'purchaseDate يجب أن يكون YYYY-MM-DD إن أمكن. purchaseValue وpurchaseValueBeforeVat يمثلان القيمة قبل الضريبة إن ظهرت بوضوح، vatRate نسبة الضريبة، vatAmount قيمة الضريبة، وpurchaseValueIncludingVat الإجمالي شامل الضريبة. جميع القيم المالية أرقام فقط دون رمز العملة.',\n      'النسبة الأساسية الحالية لضريبة القيمة المضافة في المملكة العربية السعودية هي 15%. إذا لم تظهر الضريبة بوضوح في المستند فلا تخمّن أنها مطبقة؛ أعد الحقول الضريبية null وسيطبق النظام النسبة الأساسية افتراضيًا عند الإدخال.',",
    'smart extraction VAT prompt'
  );

  fs.writeFileSync(path, s);
}

console.log('Saudi VAT asset backend patch applied.');
