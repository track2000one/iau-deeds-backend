export function notFound(req, res, next) {
  res.status(404).json({ message: 'المسار غير موجود' });
}

export function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    message: err.message || 'حدث خطأ في الخادم',
  });
}
