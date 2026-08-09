from pathlib import Path


def patch(path, old, new, count=1):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'Anchor not found in {path}: {old[:140]}')
    p.write_text(text.replace(old, new, count), encoding='utf-8')


# Prisma schema
patch('prisma/schema.prisma', '  deedDate            DateTime?\n  plotNumber', '  deedDate            DateTime?\n  deedDateType        String?   @default("gregorian")\n  plotNumber')
patch('prisma/schema.prisma', '  contractStartDate DateTime?\n  contractDuration', '  contractStartDate DateTime?\n  contractStartDateType String? @default("gregorian")\n  contractDuration')
patch('prisma/schema.prisma', '  purchaseDate  DateTime?\n  purchaseValue', '  purchaseDate  DateTime?\n  purchaseDateType String? @default("gregorian")\n  purchaseValue')
patch('prisma/schema.prisma', '  visitDate           DateTime\n  visitPurpose', '  visitDate           DateTime\n  visitDateType       String?   @default("gregorian")\n  visitPurpose')
patch('prisma/schema.prisma', '  followUpDate        DateTime?\n  workflowStatus', '  followUpDate        DateTime?\n  followUpDateType    String?   @default("gregorian")\n  workflowStatus')

# Deeds
p = Path('src/routes/deeds.routes.js')
text = p.read_text(encoding='utf-8')
text = text.replace("  deedDate: z.string().optional().nullable(),\n", "  deedDate: z.string().optional().nullable(),\n  deedDateType: z.enum(['gregorian', 'hijri']).optional().default('gregorian'),\n", 1)
old = "const toDbData = (body) => {\n  const data = deedSchema.parse(body);\n  return {\n    ...data,\n    deedDate: data.deedDate ? new Date(data.deedDate) : null,\n  };\n};"
new = """const parseFlexibleDate = (value, type = 'gregorian', fieldName = 'التاريخ') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\\d{4})[\\/-](\\d{1,2})[\\/-](\\d{1,2})/);
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

const toDbData = (body) => {
  const data = deedSchema.parse(body);
  return {
    ...data,
    deedDate: parseFlexibleDate(data.deedDate, data.deedDateType, 'تاريخ الصك'),
  };
};"""
if old not in text:
    raise SystemExit('deeds toDbData anchor not found')
p.write_text(text.replace(old, new, 1), encoding='utf-8')

# Generic records
p = Path('src/routes/records.routes.js')
text = p.read_text(encoding='utf-8')
text = text.replace("'leased-lands-out': ['tenant','contractNumber','contractStartDate','contractDuration'", "'leased-lands-out': ['tenant','contractNumber','contractStartDate','contractStartDateType','contractDuration'", 1)
marker = "const numberFields = new Set(['area', 'rentAmount']);\n"
helper = """const numberFields = new Set(['area', 'rentAmount']);

const parseFlexibleDate = (value, type = 'gregorian') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\\d{4})[\\/-](\\d{1,2})[\\/-](\\d{1,2})/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 30) return null;
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
"""
if marker not in text:
    raise SystemExit('records numberFields anchor not found')
text = text.replace(marker, helper, 1)
old = """  for (const field of dateFields) {
    if (field in data) {
      const date = data[field] ? new Date(data[field]) : null;
      data[field] = date && !Number.isNaN(date.getTime()) ? date : null;
    }
  }"""
new = """  for (const field of dateFields) {
    if (field in data) {
      const typeField = `${field}Type`;
      const dateType = mapped[typeField] === 'hijri' ? 'hijri' : 'gregorian';
      data[field] = parseFlexibleDate(data[field], dateType);
    }
  }"""
if old not in text:
    raise SystemExit('records date loop anchor not found')
p.write_text(text.replace(old, new, 1), encoding='utf-8')

# Assets
p = Path('src/routes/assets.routes.js')
text = p.read_text(encoding='utf-8')
text = text.replace("  purchaseDate: z.string().trim().optional().nullable(),\n", "  purchaseDate: z.string().trim().optional().nullable(),\n  purchaseDateType: z.enum(['gregorian', 'hijri']).optional().default('gregorian'),\n", 1)
old = """const toDate = (value, fieldName) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName} غير صحيح`);
    error.status = 400;
    throw error;
  }
  return parsed;
};"""
new = """const toDate = (value, fieldName, type = 'gregorian') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\\d{4})[\\/-](\\d{1,2})[\\/-](\\d{1,2})/);
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
};"""
if old not in text:
    raise SystemExit('assets toDate anchor not found')
text = text.replace(old, new, 1)
text = text.replace("const purchaseDate = toDate(input.purchaseDate, 'تاريخ الشراء');", "const purchaseDate = toDate(input.purchaseDate, 'تاريخ الشراء', input.purchaseDateType);", 2)
text = text.replace("          purchaseDate,\n          purchaseValue:", "          purchaseDate,\n          purchaseDateType: input.purchaseDateType,\n          purchaseValue:", 2)
p.write_text(text, encoding='utf-8')

# Site inspections
p = Path('src/routes/site-inspections.routes.js')
text = p.read_text(encoding='utf-8')
text = text.replace("  visitDate: z.string().trim().min(1, 'تاريخ الزيارة مطلوب'),\n", "  visitDate: z.string().trim().min(1, 'تاريخ الزيارة مطلوب'),\n  visitDateType: z.enum(['gregorian', 'hijri']).optional().default('gregorian'),\n", 1)
text = text.replace("  followUpDate: nullableDate,\n  workflowStatus:", "  followUpDate: nullableDate,\n  followUpDateType: z.enum(['gregorian', 'hijri']).optional().default('gregorian'),\n  workflowStatus:", 1)
old = """const toDate = (value, fieldName) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName} غير صحيح`);
    error.status = 400;
    throw error;
  }
  return parsed;
};"""
new = """const toDate = (value, fieldName, type = 'gregorian') => {
  if (!value) return null;
  if (type === 'hijri') {
    const match = String(value).trim().match(/^(\\d{4})[\\/-](\\d{1,2})[\\/-](\\d{1,2})/);
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
};"""
if old not in text:
    raise SystemExit('inspection toDate anchor not found')
text = text.replace(old, new, 1)
text = text.replace("const visitDate = toDate(input.visitDate, 'تاريخ الزيارة');", "const visitDate = toDate(input.visitDate, 'تاريخ الزيارة', input.visitDateType);", 2)
text = text.replace("const followUpDate = toDate(input.followUpDate, 'تاريخ المتابعة');", "const followUpDate = toDate(input.followUpDate, 'تاريخ المتابعة', input.followUpDateType);", 2)
text = text.replace("          visitDate,\n          visitPurpose:", "          visitDate,\n          visitDateType: input.visitDateType,\n          visitPurpose:", 2)
text = text.replace("          followUpDate,\n          workflowStatus:", "          followUpDate,\n          followUpDateType: input.followUpDateType,\n          workflowStatus:", 2)
p.write_text(text, encoding='utf-8')
