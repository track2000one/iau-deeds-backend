import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

const FIELD_LABELS = {
  deedNumber: 'رقم الصك',
  deedDate: 'تاريخ الصك',
  deedDateType: 'نوع تاريخ الصك',
  propertyDescription: 'بيان العقار',
  usageType: 'نوع الاستخدام',
  plotNumber: 'رقم القطعة',
  planNumber: 'رقم المخطط',
  area: 'المساحة',
  location: 'الموقع',
  coordinates: 'الإحداثيات',
  city: 'المدينة',
  district: 'الحي',
  region: 'المنطقة',
  notes: 'الملاحظات',
  email: 'البريد الإلكتروني',
  username: 'اسم المستخدم',
  password: 'كلمة المرور',
  name: 'الاسم',
  role: 'الدور',
  status: 'الحالة',
};

const hasArabic = (value = '') => /[\u0600-\u06FF]/.test(String(value));

const zodIssueMessage = (issue) => {
  const fieldKey = issue?.path?.length ? String(issue.path[issue.path.length - 1]) : '';
  const fieldLabel = FIELD_LABELS[fieldKey] || (fieldKey ? `الحقل «${fieldKey}»` : 'أحد الحقول');
  const rawMessage = String(issue?.message || '').trim();

  if (hasArabic(rawMessage)) return rawMessage;

  if (issue?.code === 'invalid_type') {
    if (/undefined|required/i.test(rawMessage)) return `${fieldLabel} مطلوب`;
    return `القيمة المدخلة في ${fieldLabel} غير صحيحة`;
  }

  if (issue?.code === 'too_small') {
    if (Number(issue?.minimum) <= 1) return `${fieldLabel} مطلوب`;
    return `${fieldLabel} أقصر من الحد المسموح`;
  }

  if (issue?.code === 'too_big') return `${fieldLabel} يتجاوز الحد المسموح`;
  if (issue?.code === 'invalid_format') return `صيغة ${fieldLabel} غير صحيحة`;
  if (issue?.code === 'invalid_value' || issue?.code === 'invalid_enum_value') {
    return `القيمة المختارة في ${fieldLabel} غير صحيحة`;
  }

  if (/invalid input|expected|received|too small|too big/i.test(rawMessage)) {
    return `يرجى مراجعة ${fieldLabel} وإدخال قيمة صحيحة`;
  }

  return rawMessage || 'البيانات المدخلة غير صحيحة';
};

export function notFound(_req, res) {
  res.status(404).json({ message: 'المسار غير موجود' });
}

export function errorHandler(err, _req, res, _next) {
  console.error(err);

  if (err instanceof ZodError) {
    const friendlyIssues = (err.issues || []).map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: zodIssueMessage(issue),
    }));

    return res.status(400).json({
      message: friendlyIssues[0]?.message || 'بعض البيانات المدخلة غير صحيحة. راجع الحقول وحاول مرة أخرى.',
      issues: friendlyIssues,
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        message: 'توجد قيمة مكررة في أحد الحقول الفريدة',
      });
    }

    if (err.code === 'P2025') {
      return res.status(404).json({
        message: 'السجل المطلوب غير موجود',
      });
    }
  }

  const status = err.statusCode || err.status || 500;

  return res.status(status).json({
    message: err.message || 'حدث خطأ في الخادم',
  });
}
