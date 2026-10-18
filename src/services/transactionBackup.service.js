import * as XLSX from 'xlsx';
import { prisma } from '../prisma.js';
import {
  copyGoogleDriveFile,
  deleteGoogleDriveFolder,
  downloadGoogleDriveFile,
  ensureGoogleDriveFolder,
  listGoogleDriveFolderFilesRecursive,
  uploadBufferToGoogleDrive,
} from './googleDrive.js';
import { calculateNextTransactionReportRun } from './transactionReports.service.js';

const BACKUP_SCOPE = 'global';
const BACKUP_ROOT_FOLDER = 'نسخ احتياطية - نظام المتابعة';

const safeName = (value, fallback = 'ملف') =>
  String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || fallback;

const riyadhStamp = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((item) => item.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}-${get('minute')}`;
};

const dateValue = (value) => (value ? new Date(value).toISOString() : '');
const buildWorksheet = (rows) => XLSX.utils.json_to_sheet(rows, { skipHeader: false });

const buildWorkbookBuffer = ({ transactions, attachments }) => {
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheet(transactions.map((record) => ({
      'رقم المتابعة': record.trackingNumber,
      'رقم المعاملة': record.transactionNumber,
      'السنة': record.transactionYear ?? '',
      'نوع التاريخ': record.transactionDateType === 'hijri' ? 'هجري' : 'ميلادي',
      'تاريخ المعاملة الأصلي': record.transactionDateInput || '',
      'تاريخ المعاملة ISO': dateValue(record.transactionDate),
      'نوع المعاملة': record.transactionType,
      'الموضوع': record.subject,
      'الجهة': record.sourceEntity || '',
      'الأولوية': record.priority,
      'الحالة': record.status,
      'الموظف المختص': record.currentAssigneeName || '',
      'تاريخ الإسناد': dateValue(record.assignedAt),
      'الإجراء المطلوب': record.requiredAction || '',
      'تاريخ الاستحقاق': dateValue(record.dueDate),
      'آخر إجراء': dateValue(record.lastActionAt),
      'آخر إجراء بواسطة': record.lastActionByName || '',
      'ملاحظات': record.notes || '',
      'تاريخ الإنجاز': dateValue(record.completedAt),
      'تاريخ الإقفال': dateValue(record.closedAt),
      'تاريخ الأرشفة': dateValue(record.archivedAt),
      'أرشفها': record.archivedByName || '',
      'ملاحظة الأرشفة': record.archiveNote || '',
      'أنشأها': record.createdByName || '',
      'تاريخ الإنشاء': dateValue(record.createdAt),
      'آخر تحديث': dateValue(record.updatedAt),
    }))),
    'المعاملات',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheet(transactions.flatMap((record) =>
      record.events.map((event) => ({
        'رقم المعاملة': record.transactionNumber,
        'السنة': record.transactionYear ?? '',
        'نوع الحدث': event.eventType,
        'من حالة': event.fromStatus || '',
        'إلى حالة': event.toStatus || '',
        'من موظف': event.fromAssigneeName || '',
        'إلى موظف': event.toAssigneeName || '',
        'الإجراء': event.actionText || '',
        'الملاحظة': event.note || '',
        'بواسطة': event.createdByName || '',
        'التاريخ': dateValue(event.createdAt),
      })),
    )),
    'سجل الإجراءات',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheet(transactions.flatMap((record) =>
      record.directives.map((directive) => ({
        'رقم المعاملة': record.transactionNumber,
        'السنة': record.transactionYear ?? '',
        'النوع': directive.directiveType,
        'العنوان': directive.title,
        'النص': directive.instruction,
        'الأولوية': directive.priority,
        'الحالة': directive.status,
        'المكلف': directive.assigneeName,
        'الاستحقاق': dateValue(directive.dueDate),
        'أصدره': directive.issuedByName || '',
        'تاريخ الإصدار': dateValue(directive.issuedAt),
        'رد الإنجاز': directive.completionResponse || '',
        'ملاحظة الإنجاز': directive.completionNote || '',
        'قرار المراجعة': directive.reviewDecision || '',
        'ملاحظة المراجعة': directive.reviewNote || '',
        'تاريخ المراجعة': dateValue(directive.reviewedAt),
      })),
    )),
    'التوجيهات والقرارات',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheet(transactions.flatMap((record) =>
      record.directives.flatMap((directive) =>
        directive.reviews.map((review) => ({
          'رقم المعاملة': record.transactionNumber,
          'عنوان التوجيه': directive.title,
          'القرار': review.decision,
          'الحالة السابقة': review.previousStatus,
          'الحالة التالية': review.nextStatus,
          'ملاحظة المراجعة': review.reviewNote || '',
          'رد الإنجاز': review.completionResponse || '',
          'ملاحظة الإنجاز': review.completionNote || '',
          'المراجع': review.reviewedByName || '',
          'تاريخ المراجعة': dateValue(review.reviewedAt),
        })),
      ),
    )),
    'مراجعات التوجيهات',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheet(transactions.flatMap((record) =>
      record.extensionRequests.map((request) => ({
        'رقم المعاملة': record.transactionNumber,
        'الاستحقاق السابق': dateValue(request.currentDueDate),
        'الاستحقاق المطلوب': dateValue(request.requestedDueDate),
        'السبب': request.reason,
        'الحالة': request.status,
        'طلبها': request.requestedByName,
        'راجعها': request.reviewedByName || '',
        'ملاحظة المراجعة': request.reviewNote || '',
        'تاريخ القرار': dateValue(request.decisionAt),
        'تاريخ الطلب': dateValue(request.createdAt),
      })),
    )),
    'طلبات التمديد',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheet(transactions.flatMap((record) =>
      record.externalWaits.map((wait) => ({
        'رقم المعاملة': record.transactionNumber,
        'الجهة الخارجية': wait.externalEntity,
        'رقم المرجع الصادر': wait.outboundReferenceNumber || '',
        'تاريخ الإرسال': dateValue(wait.sentAt),
        'المتابعة القادمة': dateValue(wait.nextFollowUpDate),
        'الحالة': wait.status,
        'عدد المتابعات': wait.followUpCount,
        'آخر متابعة': dateValue(wait.lastFollowUpAt),
        'ملاحظة آخر متابعة': wait.lastFollowUpNote || '',
        'تاريخ ورود الرد': dateValue(wait.responseReceivedAt),
        'رقم الرد': wait.responseReferenceNumber || '',
        'ملخص الرد': wait.responseNote || '',
      })),
    )),
    'انتظار الجهات',
  );

  const transactionById = new Map(transactions.map((record) => [record.id, record]));
  const directiveById = new Map();
  transactions.forEach((record) => {
    record.directives.forEach((directive) => {
      directiveById.set(directive.id, { transactionId: record.id, title: directive.title });
    });
  });

  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheet(attachments.map((attachment) => {
      const directive = attachment.entityType === 'transaction_follow_up_directive'
        ? directiveById.get(attachment.entityId)
        : null;
      const transaction = transactionById.get(
        attachment.entityType === 'transaction_follow_up'
          ? attachment.entityId
          : directive?.transactionId,
      );
      return {
        'رقم المعاملة': transaction?.transactionNumber || '',
        'السنة': transaction?.transactionYear ?? '',
        'المصدر': attachment.entityType === 'transaction_follow_up' ? 'المعاملة' : 'دليل توجيه/قرار',
        'عنوان التوجيه': directive?.title || '',
        'اسم الملف': attachment.title,
        'نوع الملف': attachment.mimeType || '',
        'ملاحظات': attachment.notes || '',
        'أضيف بواسطة': attachment.createdBy || '',
        'تاريخ الإضافة': dateValue(attachment.createdAt),
        'رابط Google Drive': attachment.driveUrl,
        'معرف الملف': attachment.driveFileId || '',
      };
    })),
    'المرفقات',
  );

  return {
    buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    transactionById,
    directiveById,
  };
};

export const loadFullTransactionBackupData = async () => {
  const transactions = await prisma.transactionFollowUp.findMany({
    include: {
      events: { orderBy: { createdAt: 'asc' } },
      directives: {
        include: { reviews: { orderBy: { reviewedAt: 'asc' } } },
        orderBy: { issuedAt: 'asc' },
      },
      extensionRequests: { orderBy: { createdAt: 'asc' } },
      externalWaits: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
  });

  const transactionIds = transactions.map((item) => item.id);
  const directiveIds = transactions.flatMap((item) => item.directives.map((directive) => directive.id));
  const attachments = transactionIds.length || directiveIds.length
    ? await prisma.attachment.findMany({
        where: {
          OR: [
            ...(transactionIds.length
              ? [{ entityType: 'transaction_follow_up', entityId: { in: transactionIds } }]
              : []),
            ...(directiveIds.length
              ? [{ entityType: 'transaction_follow_up_directive', entityId: { in: directiveIds } }]
              : []),
          ],
        },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  return { transactions, attachments };
};

export const verifyTransactionBackupRun = async (runId) => {
  const run = await prisma.transactionFollowUpBackupRun.findUnique({
    where: { id: runId },
  });
  if (!run) {
    const error = new Error('سجل النسخة الاحتياطية غير موجود');
    error.status = 404;
    throw error;
  }
  if (!run.folderId || !run.workbookFileId || !run.manifestFileId) {
    const integrityMessage = 'النسخة لا تحتوي على مراجع ملفات التحقق الأساسية.';
    return prisma.transactionFollowUpBackupRun.update({
      where: { id: run.id },
      data: {
        integrityStatus: 'failed',
        integrityMessage,
        verifiedFileCount: 0,
        verifiedAt: new Date(),
      },
    });
  }

  try {
    const [files, manifestDownload, workbookDownload] = await Promise.all([
      listGoogleDriveFolderFilesRecursive(run.folderId),
      downloadGoogleDriveFile(run.manifestFileId),
      downloadGoogleDriveFile(run.workbookFileId),
    ]);

    const manifest = JSON.parse(manifestDownload.buffer.toString('utf8'));
    const expectedTransactions = Number(manifest?.totals?.transactions ?? -1);
    const expectedAttachments = Number(manifest?.totals?.attachments ?? -1);
    const expectedCopiedAttachments = Number(manifest?.totals?.copiedAttachments ?? -1);

    const issues = [];
    if (!files.some((item) => item.id === run.workbookFileId)) {
      issues.push('ملف Excel غير موجود داخل مجلد النسخة.');
    }
    if (!files.some((item) => item.id === run.manifestFileId)) {
      issues.push('ملف manifest.json غير موجود داخل مجلد النسخة.');
    }
    if (!workbookDownload.buffer?.length) {
      issues.push('ملف Excel فارغ أو غير قابل للقراءة.');
    }
    if (!Array.isArray(manifest?.data?.transactions)) {
      issues.push('بيانات المعاملات داخل manifest غير صالحة.');
    }
    if (!Array.isArray(manifest?.data?.attachments)) {
      issues.push('بيانات المرفقات داخل manifest غير صالحة.');
    }
    if (expectedTransactions !== run.transactionCount) {
      issues.push(`عدد المعاملات لا يطابق السجل (${expectedTransactions} / ${run.transactionCount}).`);
    }
    if (expectedAttachments !== run.attachmentCount) {
      issues.push(`عدد المرفقات لا يطابق السجل (${expectedAttachments} / ${run.attachmentCount}).`);
    }
    if (expectedCopiedAttachments !== run.copiedAttachmentCount) {
      issues.push(`عدد المرفقات المنسوخة لا يطابق السجل (${expectedCopiedAttachments} / ${run.copiedAttachmentCount}).`);
    }

    const expectedMinimumFileCount = 2 + Math.max(0, run.copiedAttachmentCount);
    if (files.length < expectedMinimumFileCount) {
      issues.push(
        `عدد الملفات الفعلية داخل مجلد النسخة أقل من المتوقع (${files.length} / ${expectedMinimumFileCount}).`,
      );
    }

    const integrityStatus = issues.length
      ? (run.status === 'partial' ? 'warning' : 'failed')
      : (run.status === 'partial' ? 'warning' : 'success');
    const integrityMessage = issues.length
      ? issues.join(' ')
      : run.status === 'partial'
        ? 'ملفات النسخة الأساسية سليمة، لكن توجد مرفقات سبق أن تعذر نسخها.'
        : 'تم التحقق من Excel والبيانات الخام وعدد الملفات، والنسخة سليمة وقابلة للقراءة.';

    return prisma.transactionFollowUpBackupRun.update({
      where: { id: run.id },
      data: {
        integrityStatus,
        integrityMessage,
        verifiedFileCount: files.length,
        verifiedAt: new Date(),
      },
    });
  } catch (error) {
    return prisma.transactionFollowUpBackupRun.update({
      where: { id: run.id },
      data: {
        integrityStatus: 'failed',
        integrityMessage: String(error?.message || error).slice(0, 5000),
        verifiedAt: new Date(),
      },
    });
  }
};

const pruneBackupRuns = async (schedule) => {
  const retentionCount = Math.min(100, Math.max(1, Number(schedule.retentionCount || 12)));
  const olderRuns = await prisma.transactionFollowUpBackupRun.findMany({
    where: { scheduleId: schedule.id, status: { in: ['success', 'partial'] } },
    orderBy: { createdAt: 'desc' },
    skip: retentionCount,
  });

  for (const run of olderRuns) {
    if (run.folderId) {
      try {
        await deleteGoogleDriveFolder(run.folderId);
      } catch (error) {
        console.warn('Unable to delete old transaction backup folder:', error?.message || error);
        continue;
      }
    }
    await prisma.transactionFollowUpBackupRun.delete({ where: { id: run.id } });
  }
};

export const runTransactionFollowUpBackup = async ({
  schedule = null,
  triggeredById = null,
  triggeredByName = 'النظام',
} = {}) => {
  const effectiveSchedule = schedule || await prisma.transactionFollowUpBackupSchedule.upsert({
    where: { scope: BACKUP_SCOPE },
    create: {
      scope: BACKUP_SCOPE,
      isActive: false,
      updatedById: triggeredById,
      updatedByName: triggeredByName,
    },
    update: {},
  });

  const activeRun = await prisma.transactionFollowUpBackupRun.findFirst({
    where: {
      scheduleId: effectiveSchedule.id,
      status: 'running',
      startedAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    },
    orderBy: { startedAt: 'desc' },
  });
  if (activeRun) return { skipped: true, reason: 'backup_already_running', run: activeRun };

  const run = await prisma.transactionFollowUpBackupRun.create({
    data: { scheduleId: effectiveSchedule.id, status: 'running', startedAt: new Date() },
  });

  try {
    const rootFolder = await ensureGoogleDriveFolder(BACKUP_ROOT_FOLDER);
    const folderName = `نسخة-نظام-المتابعة-${riyadhStamp()}`;
    const backupFolder = await ensureGoogleDriveFolder(folderName, rootFolder.id);
    const { transactions, attachments } = await loadFullTransactionBackupData();
    const { buffer: workbookBuffer, transactionById, directiveById } =
      buildWorkbookBuffer({ transactions, attachments });

    const workbook = await uploadBufferToGoogleDrive(
      {
        buffer: workbookBuffer,
        originalname: 'تقرير-نظام-المتابعة.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      {
        fileName: 'تقرير-نظام-المتابعة.xlsx',
        folderId: backupFolder.id,
        makePublic: false,
      },
    );

    const copyFailures = [];
    let copiedAttachmentCount = 0;
    const transactionFolders = new Map();

    if (effectiveSchedule.includeAttachments) {
      for (const attachment of attachments) {
        if (!attachment.driveFileId) {
          copyFailures.push({
            attachmentId: attachment.id,
            title: attachment.title,
            reason: 'لا يوجد معرف Google Drive',
          });
          continue;
        }

        const directive = attachment.entityType === 'transaction_follow_up_directive'
          ? directiveById.get(attachment.entityId)
          : null;
        const transactionId = attachment.entityType === 'transaction_follow_up'
          ? attachment.entityId
          : directive?.transactionId;
        const transaction = transactionById.get(transactionId);

        if (!transaction) {
          copyFailures.push({
            attachmentId: attachment.id,
            title: attachment.title,
            reason: 'تعذر تحديد المعاملة المرتبطة',
          });
          continue;
        }

        try {
          let transactionFolder = transactionFolders.get(transaction.id);
          if (!transactionFolder) {
            transactionFolder = await ensureGoogleDriveFolder(
              `معاملة-${safeName(transaction.transactionNumber)}-${transaction.transactionYear || 'بدون-سنة'}`,
              backupFolder.id,
            );
            transactionFolders.set(transaction.id, transactionFolder);
          }
          const prefix = attachment.entityType === 'transaction_follow_up_directive'
            ? `توجيه-${safeName(directive?.title || 'دليل')}-`
            : '';
          await copyGoogleDriveFile(
            attachment.driveFileId,
            transactionFolder.id,
            `${prefix}${safeName(attachment.title, 'مرفق')}`,
          );
          copiedAttachmentCount += 1;
        } catch (error) {
          copyFailures.push({
            attachmentId: attachment.id,
            title: attachment.title,
            reason: error?.message || 'تعذر نسخ الملف',
          });
        }
      }
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      backupType: 'transaction-follow-up-full',
      includeAttachments: effectiveSchedule.includeAttachments,
      totals: {
        transactions: transactions.length,
        events: transactions.reduce((sum, item) => sum + item.events.length, 0),
        directives: transactions.reduce((sum, item) => sum + item.directives.length, 0),
        attachments: attachments.length,
        copiedAttachments: copiedAttachmentCount,
        failedAttachments: copyFailures.length,
      },
      copyFailures,
      data: { transactions, attachments },
    };

    const manifestUpload = await uploadBufferToGoogleDrive(
      {
        buffer: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
        originalname: 'manifest.json',
        mimetype: 'application/json',
      },
      {
        fileName: 'manifest.json',
        folderId: backupFolder.id,
        makePublic: false,
      },
    );

    const finalStatus = copyFailures.length ? 'partial' : 'success';
    const completed = await prisma.transactionFollowUpBackupRun.update({
      where: { id: run.id },
      data: {
        status: finalStatus,
        folderId: backupFolder.id,
        folderUrl: backupFolder.webViewLink,
        folderName,
        workbookFileId: workbook.driveFileId,
        workbookUrl: workbook.driveUrl,
        manifestFileId: manifestUpload.driveFileId,
        manifestUrl: manifestUpload.driveUrl,
        transactionCount: transactions.length,
        attachmentCount: attachments.length,
        copiedAttachmentCount,
        failedAttachmentCount: copyFailures.length,
        completedAt: new Date(),
      },
    });

    const verified = await verifyTransactionBackupRun(completed.id);
    await pruneBackupRuns(effectiveSchedule);
    return { skipped: false, run: verified, copyFailures };
  } catch (error) {
    const failed = await prisma.transactionFollowUpBackupRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        errorMessage: String(error?.message || error).slice(0, 5000),
        completedAt: new Date(),
      },
    });
    return { skipped: false, run: failed, error };
  }
};

export const syncScheduledTransactionBackups = async (now = new Date()) => {
  const schedule = await prisma.transactionFollowUpBackupSchedule.findUnique({
    where: { scope: BACKUP_SCOPE },
  });
  if (!schedule?.isActive) return { scanned: 0, generated: 0 };
  if (schedule.nextRunAt && schedule.nextRunAt.getTime() > now.getTime()) {
    return { scanned: 1, generated: 0 };
  }

  const result = await runTransactionFollowUpBackup({ schedule });
  await prisma.transactionFollowUpBackupSchedule.update({
    where: { id: schedule.id },
    data: {
      lastRunAt: now,
      nextRunAt: calculateNextTransactionReportRun(schedule, now),
    },
  });

  return {
    scanned: 1,
    generated: result.skipped ? 0 : 1,
    status: result.run?.status || null,
  };
};

export const getOrCreateTransactionBackupSchedule = async () =>
  prisma.transactionFollowUpBackupSchedule.upsert({
    where: { scope: BACKUP_SCOPE },
    create: { scope: BACKUP_SCOPE, isActive: false },
    update: {},
  });

export const updateTransactionBackupSchedule = async ({
  frequency,
  dayOfWeek,
  dayOfMonth,
  runHour,
  includeAttachments,
  retentionCount,
  isActive,
  updatedById,
  updatedByName,
}) => {
  const current = await getOrCreateTransactionBackupSchedule();
  const next = {
    frequency,
    dayOfWeek: frequency === 'weekly' ? dayOfWeek : null,
    dayOfMonth: frequency === 'monthly' ? dayOfMonth : null,
    runHour,
    includeAttachments,
    retentionCount,
    isActive,
    updatedById,
    updatedByName,
  };
  return prisma.transactionFollowUpBackupSchedule.update({
    where: { id: current.id },
    data: {
      ...next,
      nextRunAt: isActive ? calculateNextTransactionReportRun(next) : null,
    },
  });
};
