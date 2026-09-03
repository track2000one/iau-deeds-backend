from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    text = text.replace(old, new, 1)


personnel_schema = """const personnelAccountSchema = z.object({
  siteId: z.string().min(1),
  name: z.string().trim().min(2),
  role: z.enum(['imam', 'muezzin', 'khateeb', 'collaborating_khateeb']),
  mobile: z.string().trim().optional().nullable(),
  email: z.string().email(),
});"""

public_schemas = personnel_schema + """

const publicTicketSchema = z.object({
  siteToken: z.string().trim().min(1).max(120).optional().nullable(),
  siteId: z.string().trim().min(1).max(120).optional().nullable(),
  ticketType: z.string().trim().min(1).max(100).optional().default('general'),
  description: z.string().trim().min(5, 'وصف البلاغ يجب ألا يقل عن 5 أحرف').max(5000),
  reporterName: z.string().trim().max(200).optional().nullable(),
  reporterPhone: z.string().trim().max(30).optional().nullable(),
  reporterEmail: z.string().trim().email('البريد الإلكتروني غير صحيح').optional().nullable(),
});

const publicJobSchema = z.object({
  fullName: z.string().trim().min(2, 'الاسم مطلوب').max(200),
  nationalId: z.string().regex(/^\\d{10}$/, 'رقم السجل المدني يجب أن يتكون من 10 أرقام'),
  phone: z.string().trim().min(8, 'رقم الجوال غير صحيح').max(30),
  email: z.string().trim().email('البريد الإلكتروني غير صحيح'),
  qualification: z.string().trim().min(2, 'المؤهل العلمي مطلوب').max(300),
  experience: z.string().trim().max(5000).optional().nullable(),
  jobType: z.string().trim().min(2, 'الوظيفة المتقدم عليها مطلوبة').max(150),
  preferredLocation: z.string().trim().max(300).optional().nullable(),
});"""
replace_once(personnel_schema, public_schemas, 'public schemas')

old_ticket = """mosquesPublicRoutes.post('/tickets', publicUpload.single('file'), async (req, res, next) => {
  try {
    const site = req.body.siteToken
      ? await prisma.mosqueSite.findUnique({ where: { publicToken: String(req.body.siteToken) } })
      : req.body.siteId
        ? await prisma.mosqueSite.findUnique({ where: { id: String(req.body.siteId) } })
        : null;
    if (!site) return res.status(400).json({ message: 'اختر المسجد أو المصلى' });

    const description = String(req.body.description || '').trim();
    if (description.length < 5) return res.status(400).json({ message: 'وصف البلاغ يجب ألا يقل عن 5 أحرف' });"""
new_ticket = """mosquesPublicRoutes.post('/tickets', publicUpload.single('file'), async (req, res, next) => {
  try {
    const input = publicTicketSchema.parse({
      siteToken: nullableText(req.body.siteToken),
      siteId: nullableText(req.body.siteId),
      ticketType: nullableText(req.body.ticketType) || 'general',
      description: req.body.description,
      reporterName: nullableText(req.body.reporterName),
      reporterPhone: nullableText(req.body.reporterPhone),
      reporterEmail: nullableText(req.body.reporterEmail),
    });
    const site = input.siteToken
      ? await prisma.mosqueSite.findUnique({ where: { publicToken: input.siteToken } })
      : input.siteId
        ? await prisma.mosqueSite.findUnique({ where: { id: input.siteId } })
        : null;
    if (!site) return res.status(400).json({ message: 'اختر المسجد أو المصلى' });

    const description = input.description;"""
replace_once(old_ticket, new_ticket, 'public ticket validation')

replace_once(
    """        ticketType: nullableText(req.body.ticketType) || 'general',
        description,
        reporterName: nullableText(req.body.reporterName),
        reporterPhone: nullableText(req.body.reporterPhone),
        reporterEmail: nullableText(req.body.reporterEmail),""",
    """        ticketType: input.ticketType,
        description,
        reporterName: input.reporterName || null,
        reporterPhone: input.reporterPhone || null,
        reporterEmail: input.reporterEmail || null,""",
    'validated ticket fields',
)

old_job = """mosquesPublicRoutes.post('/jobs', publicUpload.fields([{ name: 'cv', maxCount: 1 }, { name: 'certificate', maxCount: 1 }]), async (req, res, next) => {
  try {
    const required = ['fullName', 'nationalId', 'phone', 'email', 'qualification', 'jobType'];
    for (const field of required) {
      if (!nullableText(req.body[field])) return res.status(400).json({ message: `الحقل ${field} مطلوب` });
    }

    const cvFile = req.files?.cv?.[0];"""
new_job = """mosquesPublicRoutes.post('/jobs', publicUpload.fields([{ name: 'cv', maxCount: 1 }, { name: 'certificate', maxCount: 1 }]), async (req, res, next) => {
  try {
    const input = publicJobSchema.parse({
      fullName: req.body.fullName,
      nationalId: String(req.body.nationalId || '').replace(/\\D/g, ''),
      phone: req.body.phone,
      email: req.body.email,
      qualification: req.body.qualification,
      experience: nullableText(req.body.experience),
      jobType: req.body.jobType,
      preferredLocation: nullableText(req.body.preferredLocation),
    });

    const cvFile = req.files?.cv?.[0];"""
replace_once(old_job, new_job, 'public job validation')

replace_once(
    """        fullName: String(req.body.fullName).trim(),
        nationalId: String(req.body.nationalId).trim(),
        phone: String(req.body.phone).trim(),
        email: String(req.body.email).trim().toLowerCase(),
        qualification: String(req.body.qualification).trim(),
        experience: nullableText(req.body.experience),
        jobType: String(req.body.jobType).trim(),
        preferredLocation: nullableText(req.body.preferredLocation),""",
    """        fullName: input.fullName,
        nationalId: input.nationalId,
        phone: input.phone,
        email: input.email.toLowerCase(),
        qualification: input.qualification,
        experience: input.experience || null,
        jobType: input.jobType,
        preferredLocation: input.preferredLocation || null,""",
    'validated public job fields',
)

replace_once(
    """    const data = sanitizeWorkflowEdit(kind, req.body || {});
    data.status = kind === 'request' ? 'new' : 'pending';""",
    """    const data = sanitizeWorkflowEdit(kind, req.body || {});
    if (kind === 'leave') {
      if ((data.startDate && Number.isNaN(data.startDate.getTime())) || (data.endDate && Number.isNaN(data.endDate.getTime()))) {
        return res.status(400).json({ message: 'تاريخ الإجازة أو الاعتذار غير صحيح' });
      }
      const effectiveStart = data.startDate || current.startDate;
      const effectiveEnd = data.endDate || current.endDate;
      if (effectiveEnd < effectiveStart) return res.status(400).json({ message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' });
    }
    data.status = kind === 'request' ? 'new' : 'pending';""",
    'resubmit date validation',
)

replace_once(
    """    } else if (kind === 'job') {
      if (note) data.internalNotes = note;
      if (req.body?.interviewAt) data.interviewAt = new Date(req.body.interviewAt);
    }

    const updated = await model.update({ where: { id: current.id }, data });""",
    """    } else if (kind === 'job') {
      if (note) data.internalNotes = note;
      if (req.body?.interviewAt) {
        data.interviewAt = new Date(req.body.interviewAt);
        if (Number.isNaN(data.interviewAt.getTime())) return res.status(400).json({ message: 'موعد المقابلة غير صحيح' });
      }
    }

    const updated = await model.update({ where: { id: current.id }, data });""",
    'workflow action interview validation',
)

path.write_text(text)
