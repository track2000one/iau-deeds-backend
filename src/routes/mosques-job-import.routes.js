import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const batchSchema = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(5000),
  sourceFileName: z.string().trim().max(255).optional().nullable(),
  sourceSheet: z.string().trim().max(255).optional().nullable(),
});

const collapseSpaces = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const textOrNull = (value) => {
  const valueText = collapseSpaces(value);
  return valueText || null;
};
const normalizeEmail = (value) => collapseSpaces(value).toLowerCase();
const normalizeNationalId = (value) => String(value ?? '').replace(/\D/g, '').trim();
const normalizePhone = (value) => String(value ?? '').replace(/\s+/g, '').trim();
const normalizeApplicationNumber = (value) => collapseSpaces(value).toUpperCase();
const normalizeComparable = (value) => collapseSpaces(value).toLocaleLowerCase('ar');

const buildExperience = (row) => {
  const parts = [];
  if (textOrNull(row.experienceYears)) parts.push(`إجمالي سنوات الخبرة: ${collapseSpaces(row.experienceYears)}`);
  if (textOrNull(row.experienceStart)) parts.push(`بداية الخبرة: ${collapseSpaces(row.experienceStart)}`);
  if (textOrNull(row.experienceEnd)) parts.push(`نهاية الخبرة: ${collapseSpaces(row.experienceEnd)}`);
  return parts.length ? parts.join(' | ') : null;
};

const normalizeRow = (row, index) => ({
  sourceRow: Number(row.sourceRow) || index + 2,
  fullName: collapseSpaces(row.fullName),
  nationalId: normalizeNationalId(row.nationalId),
  phone: normalizePhone(row.phone),
  email: normalizeEmail(row.email),
  qualification: collapseSpaces(row.qualification),
  jobType: collapseSpaces(row.jobType),
  experience: buildExperience(row),
  applicantType: textOrNull(row.applicantType),
  competition: textOrNull(row.competition),
  applicationNumber: normalizeApplicationNumber(row.applicationNumber),
  qualificationDate: textOrNull(row.qualificationDate),
  governmentEmployment: textOrNull(row.governmentEmployment),
  gender: textOrNull(row.gender),
  birthDate: textOrNull(row.birthDate),
  birthPlace: textOrNull(row.birthPlace),
  address: textOrNull(row.address),
  sourceStatus: textOrNull(row.sourceStatus),
  reviewerDate: textOrNull(row.reviewerDate),
  reviewer: textOrNull(row.reviewer),
  reviewerNotes: textOrNull(row.reviewerNotes),
  specialty: textOrNull(row.specialty),
});

const validateNormalizedRow = (row) => {
  const missing = [];
  if (!row.applicationNumber) missing.push('رقم الطلب');
  if (!row.fullName) missing.push('الاسم');
  if (!/^\d{10}$/.test(row.nationalId)) missing.push('رقم السجل المدني الصحيح');
  if (!row.phone) missing.push('رقم الجوال');
  if (!row.email || !row.email.includes('@')) missing.push('البريد الإلكتروني');
  if (!row.qualification) missing.push('المؤهل العلمي');
  if (!row.jobType) missing.push('الوظيفة المتقدم عليها');
  return missing.length ? `حقول ناقصة أو غير صحيحة: ${missing.join('، ')}` : null;
};

const fieldDefinitions = [
  ['fullName', 'الاسم'],
  ['phone', 'رقم الجوال'],
  ['email', 'البريد الإلكتروني'],
  ['qualification', 'المؤهل العلمي'],
  ['jobType', 'الوظيفة المتقدم عليها'],
  ['experience', 'بيانات الخبرة'],
];

const changedFields = (existing, incoming) => fieldDefinitions.flatMap(([key, label]) => {
  const before = existing?.[key] ?? '';
  const after = incoming?.[key] ?? '';
  if (normalizeComparable(before) === normalizeComparable(after)) return [];
  return [{ field: key, label, before: before || null, after: after || null }];
});

const hasFullMosquePermission = (user) => {
  const permission = user?.permissions?.find((item) => item.module === 'mosques');
  return Boolean(
    permission?.canView &&
    permission?.canAdd &&
    permission?.canEdit &&
    permission?.canDelete &&
    permission?.canPrint
  );
};

const requireImportManager = async (req, res, next) => {
  try {
    if (req.authUser?.role === 'admin' || hasFullMosquePermission(req.authUser)) return next();
    const assignment = await prisma.mosqueUserAssignment.findUnique({
      where: { userId: req.authUser.id },
      select: { role: true },
    });
    if (assignment?.role !== 'head') {
      return res.status(403).json({ message: 'استيراد طلبات التعاون متاح لرئيس الوحدة أو المسؤول المخول فقط' });
    }
    next();
  } catch (error) {
    next(error);
  }
};

const buildPreview = async ({ rows, sourceFileName = null, sourceSheet = null }) => {
  const normalizedRows = rows.map(normalizeRow);
  const validRows = normalizedRows.filter((row) => !validateNormalizedRow(row));
  const applicationNumbers = [...new Set(validRows.map((row) => row.applicationNumber).filter(Boolean))];
  const nationalIds = [...new Set(validRows.map((row) => row.nationalId).filter(Boolean))];

  const [existingApplications, sameApplicants] = await Promise.all([
    applicationNumbers.length
      ? prisma.mosqueJobApplication.findMany({
          where: { applicationNumber: { in: applicationNumbers } },
          select: {
            id: true,
            applicationNumber: true,
            fullName: true,
            nationalId: true,
            phone: true,
            email: true,
            qualification: true,
            experience: true,
            jobType: true,
            status: true,
          },
        })
      : [],
    nationalIds.length
      ? prisma.mosqueJobApplication.findMany({
          where: { nationalId: { in: nationalIds } },
          select: { id: true, applicationNumber: true, nationalId: true, jobType: true, status: true },
          orderBy: { createdAt: 'desc' },
        })
      : [],
  ]);

  const existingByApplication = new Map(existingApplications.map((item) => [normalizeApplicationNumber(item.applicationNumber), item]));
  const existingByNational = new Map();
  for (const item of sameApplicants) {
    const key = normalizeNationalId(item.nationalId);
    if (!existingByNational.has(key)) existingByNational.set(key, []);
    existingByNational.get(key).push(item);
  }

  const sourceApplicationCounts = new Map();
  for (const row of normalizedRows) {
    if (!row.applicationNumber) continue;
    sourceApplicationCounts.set(row.applicationNumber, (sourceApplicationCounts.get(row.applicationNumber) || 0) + 1);
  }

  const items = normalizedRows.map((row) => {
    const invalidReason = validateNormalizedRow(row);
    const base = {
      ...row,
      sourceFileName,
      sourceSheet,
      changedFields: [],
      relatedApplications: [],
      existingId: null,
    };

    if (invalidReason) return { ...base, matchType: 'invalid', message: invalidReason };
    if ((sourceApplicationCounts.get(row.applicationNumber) || 0) > 1) {
      return { ...base, matchType: 'conflict', message: 'رقم الطلب مكرر داخل ملف الاستيراد نفسه' };
    }

    const existing = existingByApplication.get(row.applicationNumber);
    if (existing) {
      if (normalizeNationalId(existing.nationalId) !== row.nationalId) {
        return {
          ...base,
          existingId: existing.id,
          matchType: 'conflict',
          message: 'رقم الطلب موجود في المنصة لكنه مرتبط برقم سجل مدني مختلف',
        };
      }
      const changes = changedFields(existing, row);
      return {
        ...base,
        existingId: existing.id,
        changedFields: changes,
        matchType: changes.length ? 'update' : 'identical',
        message: changes.length ? 'الطلب موجود وتوجد بيانات أحدث قابلة للتحديث' : 'الطلب مطابق بالكامل ولا يحتاج إلى إجراء',
      };
    }

    const relatedApplications = (existingByNational.get(row.nationalId) || []).map((item) => ({
      id: item.id,
      applicationNumber: item.applicationNumber,
      jobType: item.jobType,
      status: item.status,
    }));

    if (relatedApplications.length) {
      return {
        ...base,
        relatedApplications,
        matchType: 'existing_applicant_new_application',
        message: 'المتقدم موجود سابقًا، لكن رقم الطلب جديد وسيُنشأ كطلب مستقل',
      };
    }

    return { ...base, matchType: 'new_applicant', message: 'متقدم جديد وطلب جديد' };
  });

  const counts = items.reduce((acc, item) => {
    acc[item.matchType] = (acc[item.matchType] || 0) + 1;
    return acc;
  }, {});

  return {
    total: items.length,
    counts: {
      new_applicant: counts.new_applicant || 0,
      existing_applicant_new_application: counts.existing_applicant_new_application || 0,
      update: counts.update || 0,
      identical: counts.identical || 0,
      conflict: counts.conflict || 0,
      invalid: counts.invalid || 0,
    },
    items,
  };
};

router.post('/preview', requireImportManager, async (req, res, next) => {
  try {
    const input = batchSchema.parse(req.body);
    res.json(await buildPreview(input));
  } catch (error) {
    next(error);
  }
});

router.post('/commit', requireImportManager, async (req, res, next) => {
  try {
    const input = batchSchema.parse(req.body);
    const preview = await buildPreview(input);
    const updateItems = preview.items.filter((item) => item.matchType === 'update');
    const permission = req.authUser?.permissions?.find((item) => item.module === 'mosques');
    const canEdit = req.authUser?.role === 'admin' || Boolean(permission?.canEdit);

    if (updateItems.length && !canEdit) {
      return res.status(403).json({ message: 'توجد سجلات تحتاج تحديثًا، ولا يملك الحساب صلاحية التعديل عليها' });
    }

    const createdItems = preview.items.filter((item) => ['new_applicant', 'existing_applicant_new_application'].includes(item.matchType));

    const result = await prisma.$transaction(async (tx) => {
      const committed = [];

      for (const item of createdItems) {
        const created = await tx.mosqueJobApplication.create({
          data: {
            applicationNumber: item.applicationNumber,
            fullName: item.fullName,
            nationalId: item.nationalId,
            phone: item.phone,
            email: item.email,
            qualification: item.qualification,
            experience: item.experience,
            jobType: item.jobType,
            preferredLocation: null,
            status: 'new',
          },
          select: { id: true, applicationNumber: true },
        });
        committed.push({ applicationNumber: created.applicationNumber, action: 'created', id: created.id });
      }

      for (const item of updateItems) {
        const updated = await tx.mosqueJobApplication.update({
          where: { id: item.existingId },
          data: {
            fullName: item.fullName,
            phone: item.phone,
            email: item.email,
            qualification: item.qualification,
            experience: item.experience,
            jobType: item.jobType,
          },
          select: { id: true, applicationNumber: true },
        });
        committed.push({ applicationNumber: updated.applicationNumber, action: 'updated', id: updated.id });
      }

      return committed;
    });

    res.json({
      message: 'تم تنفيذ الاستيراد والمطابقة بنجاح',
      summary: {
        total: preview.total,
        created: createdItems.length,
        updated: updateItems.length,
        identical: preview.counts.identical,
        conflicts: preview.counts.conflict,
        invalid: preview.counts.invalid,
        skipped: preview.counts.identical + preview.counts.conflict + preview.counts.invalid,
      },
      items: result,
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      error.statusCode = 409;
      error.message = 'حدث تعارض أثناء الحفظ بسبب رقم طلب مكرر. أعد تنفيذ المطابقة ثم حاول مرة أخرى.';
    }
    next(error);
  }
});

export default router;
