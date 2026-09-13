# مطابقة سجل مستندات الإثبات مع AuditLog

أضيفت آلية إدارية آمنة لمقارنة الأحداث المحفوظة داخل `__propertyControlAnalysis.evidenceChecklist[].history` مع النسخ المرآة الموجودة في جدول `AuditLog`.

## نقاط النهاية

- `GET /api/accounting-transformation/admin/evidence-audit/reconciliation`
  - فحص للقراءة فقط.
  - يعرض عدد السجلات المفحوصة، الأحداث المتوقعة، الموثقة، المفقودة، المختلفة، وسجلات AuditLog التاريخية التي لا يقابلها حدث في السجل الحالي.

- `POST /api/accounting-transformation/admin/evidence-audit/reconciliation/backfill`
  - يضيف النسخ المرآة المفقودة فقط.
  - لا يعدل أو يحذف أي صف موجود في `AuditLog`.
  - لا يصلح الاختلافات تلقائيًا؛ بل يتركها للمراجعة اليدوية.

كلا المسارين يعملان تحت `/admin` ويتطلبان دور مدير النظام بالإضافة إلى صلاحية `accounting_transformation`.

## التصنيفات

- `verified`: النسخة المضمنة في سجل العقار مطابقة لنسخة AuditLog.
- `missing_mirror`: الحدث موجود في سجل العقار ولا توجد له نسخة AuditLog.
- `mismatch`: النسخة موجودة لكن أحد الحقول الرقابية يختلف؛ لا يتم تعديلها تلقائيًا.
- `auditOnly`: نسخة تاريخية في AuditLog لا يقابلها حدث في السجل الحالي. تُحفظ ولا تُحذف تلقائيًا لأنها قد تخص سجلًا تاريخيًا أو محذوفًا.

## مبدأ الأمان

عملية Backfill هي **Missing-only**. لا توجد في هذه الآلية أي عملية Update/Delete على صف AuditLog موجود. كما يسجل تشغيل Backfill نفسه كحدث تدقيق إداري.
