import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

export function notFound(_req, res) {
  res.status(404).json({ message: 'المسار غير موجود' });
}

export function errorHandler(err, _req, res, _next) {
  console.error(err);

  if (err instanceof ZodError) {
    return res.status(400).json({
      message: err.issues?.[0]?.message || 'البيانات المدخلة غير صحيحة',
      issues: err.issues,
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
