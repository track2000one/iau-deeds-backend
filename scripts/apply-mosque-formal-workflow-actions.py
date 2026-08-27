from pathlib import Path

path = Path('src/routes/mosques.routes.js')
text = path.read_text(encoding='utf-8')
marker = '\nexport default router;\n'
if marker not in text:
    raise SystemExit('export marker not found')
if "router.patch('/workflow/:kind/:id/action'" in text:
    print('Formal workflow routes already present; nothing to do.')
    raise SystemExit(0)

block = r'''

// -----------------------------------------------------------------------------
// Formal workflow administration for mosque-unit cards.
// Keeps operational records auditable: administrative edit, return, reject,
// approve, archive (soft-delete), resubmission, and history.
// -----------------------------------------------------------------------------
const MOSQUE_WORKFLOW_CONFIG = {
  request: { model: 'mosqueRequest', numberField: 'requestNumber', siteField: 'siteId' },
  ticket: { model: 'mosqueTicket', numberField: 'ticketNumber', siteField: 'siteId' },
  leave: { model: 'mosqueLeaveRequest', numberField: 'leaveNumber', siteField: 'siteId' },
  job: { model: 'mosqueJobApplication', numberField: 'applicationNumber', siteField: null },
};

const getWorkflowConfig = (kind) => MOSQUE_WORKFLOW_CONFIG[String(kind || '').trim()] || null;

const getWorkflowAllowedTransitions = (kind, status) => {
  const baseMap = kind === 'request' ? REQUEST_TRANSITIONS
    : kind === 'ticket' ? TICKET_TRANSITIONS
      : kind === 'leave' ? LEAVE_TRANSITIONS
        : JOB_TRANSITIONS;
  const allowed = [...(baseMap[status] || [])];

  // Official return-for-edit is also available for reports and recruitment.
  if (kind === 'ticket' && ['new', 'under_review', 'assigned'].includes(status) && !allowed.includes('returned_for_edit')) allowed.push('returned_for_edit');
  if (kind === 'ticket' && status === 'returned_for_edit') allowed.push('new');
  if (kind === 'job' && ['new', 'under_review', 'shortlisted', 'interview'].includes(status) && !allowed.includes('returned_for_edit')) allowed.push('returned_for_edit');
  if (kind === 'job' && status === 'returned_for_edit') allowed.push('new');

  // "Delete" in the UI is implemented as governance-safe archiving.
  if (status !== 'archived' && !allowed.includes('archived')) allowed.push('archived');
  return [...new Set(allowed)];
};

const workflowEntityLabel = (kind, item, config) => item?.[config.numberField] || `${kind}:${item?.id || ''}`;

const logMosqueWorkflowAction = async ({ req, kind, item, action, fromStatus = null, toStatus = null, note = null, previousData = null, newData = null }) => {
  try {
    const config = getWorkflowConfig(kind);
    await prisma.auditLog.create({
      data: {
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        userEmail: req.authUser?.email || null,
        userRole: req.authUser?.role || null,
        action,
        module: 'mosques',
        entity: `${kind}_workflow`,
        entityId: item?.id || null,
        entityLabel: config ? workflowEntityLabel(kind, item, config) : item?.id || null,
        description: note || `${action}: ${fromStatus || '-'} -> ${toStatus || '-'}`,
        details: { kind, fromStatus, toStatus, note },
        previousData,
        newData,
      },
    });
  } catch (error) {
    console.warn('Unable to write mosque workflow audit log:', error?.message || error);
  }
};

const assertWorkflowAccess = async (req, kind, item, context) => {
  if (context.role === 'head') return;
  if (kind === 'job') {
    const error = new Error('طلبات التوظيف من صلاحية رئيس الوحدة');
    error.statusCode = 403;
    throw error;
  }
  if (context.role === 'supervisor') {
    await assertSupervisorSiteAccess(req, item.siteId, context);
    return;
  }
  const error = new Error('لا تملك صلاحية إدارة هذا الإجراء');
  error.statusCode = 403;
  throw error;
};

const sanitizeWorkflowEdit = (kind, input) => {
  const data = {};
  const copy = (key, transform = (v) => v) => {
    if (Object.prototype.hasOwnProperty.call(input, key)) data[key] = transform(input[key]);
  };
  const textOrNull = (value) => nullableText(value);

  if (kind === 'request') {
    copy('siteId', (v) => String(v || '').trim());
    copy('requestType', (v) => String(v || '').trim());
    copy('description', (v) => String(v || '').trim());
    copy('priority', (v) => String(v || '').trim());
    copy('notes', textOrNull);
    copy('assignedTo', textOrNull);
  } else if (kind === 'ticket') {
    copy('siteId', (v) => String(v || '').trim());
    copy('ticketType', (v) => String(v || '').trim());
    copy('description', (v) => String(v || '').trim());
    copy('reporterName', textOrNull);
    copy('reporterPhone', textOrNull);
    copy('reporterEmail', textOrNull);
    copy('assignedTo', textOrNull);
    copy('notes', textOrNull);
  } else if (kind === 'leave') {
    copy('siteId', (v) => String(v || '').trim());
    copy('requestType', (v) => String(v || '').trim());
    copy('startDate', (v) => new Date(v));
    copy('endDate', (v) => new Date(v));
    copy('reason', (v) => String(v || '').trim());
    copy('replacementName', (v) => String(v || '').trim());
    copy('replacementUserId', textOrNull);
    copy('notes', textOrNull);
  } else if (kind === 'job') {
    copy('fullName', (v) => String(v || '').trim());
    copy('phone', (v) => String(v || '').trim());
    copy('email', (v) => String(v || '').trim());
    copy('qualification', (v) => String(v || '').trim());
    copy('experience', textOrNull);
    copy('jobType', (v) => String(v || '').trim());
    copy('preferredLocation', textOrNull);
    copy('internalNotes', textOrNull);
    copy('interviewAt', (v) => v ? new Date(v) : null);
  }
  return data;
};

router.get('/workflow/:kind/:id/history', async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const config = getWorkflowConfig(kind);
    if (!config) return res.status(400).json({ message: 'نوع الإجراء غير مدعوم' });
    const rows = await prisma.auditLog.findMany({
      where: { module: 'mosques', entity: `${kind}_workflow`, entityId: req.params.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, action: true, description: true, details: true, username: true, userEmail: true, userRole: true, createdAt: true },
    });
    res.json(rows);
  } catch (error) { next(error); }
});

router.patch('/workflow/:kind/:id', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const config = getWorkflowConfig(kind);
    if (!config) return res.status(400).json({ message: 'نوع الإجراء غير مدعوم' });
    const model = prisma[config.model];
    const current = await model.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الإجراء غير موجود' });
    const context = req.mosqueRole || await getModuleRole(req);
    await assertWorkflowAccess(req, kind, current, context);

    const data = sanitizeWorkflowEdit(kind, req.body || {});
    if (!Object.keys(data).length) return res.status(400).json({ message: 'لا توجد بيانات قابلة للتعديل' });
    const updated = await model.update({ where: { id: current.id }, data });
    await logMosqueWorkflowAction({ req, kind, item: updated, action: 'administrative_edit', fromStatus: current.status, toStatus: updated.status, note: nullableText(req.body?.adminNote) || 'تعديل إداري على بيانات المعاملة', previousData: current, newData: updated });
    res.json(updated);
  } catch (error) { next(error); }
});

router.patch('/workflow/:kind/:id/action', requireRoles('head', 'supervisor'), async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const config = getWorkflowConfig(kind);
    if (!config) return res.status(400).json({ message: 'نوع الإجراء غير مدعوم' });
    const model = prisma[config.model];
    const current = await model.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الإجراء غير موجود' });
    const context = req.mosqueRole || await getModuleRole(req);
    await assertWorkflowAccess(req, kind, current, context);

    const nextStatus = String(req.body?.status || '').trim();
    const allowed = getWorkflowAllowedTransitions(kind, current.status);
    if (!allowed.includes(nextStatus)) return res.status(400).json({ message: `لا يمكن تغيير الحالة من ${current.status} إلى ${nextStatus}` });
    if (nextStatus === 'archived' && context.role !== 'head') return res.status(403).json({ message: 'الحذف/الأرشفة من صلاحية رئيس الوحدة' });
    if (nextStatus === 'approved' && ['request', 'leave'].includes(kind) && context.role !== 'head') return res.status(403).json({ message: 'الاعتماد من صلاحية رئيس الوحدة' });

    const note = nullableText(req.body?.note || req.body?.rejectionReason || req.body?.returnReason);
    if (['rejected', 'returned_for_edit', 'archived'].includes(nextStatus) && !note) {
      return res.status(400).json({ message: nextStatus === 'rejected' ? 'سبب الرفض إلزامي' : nextStatus === 'returned_for_edit' ? 'سبب الإعادة للتعديل إلزامي' : 'سبب الحذف/الأرشفة إلزامي' });
    }
    if (kind === 'request' && nextStatus === 'completed' && !nullableText(req.body?.completionEvidenceUrl) && !current.completionEvidenceUrl) {
      return res.status(400).json({ message: 'يلزم إرفاق ما يثبت الإنجاز قبل تحويل الطلب إلى مكتمل' });
    }

    const data = { status: nextStatus };
    if (kind === 'request') {
      if (nextStatus === 'rejected') data.rejectionReason = note;
      if (nextStatus === 'returned_for_edit') data.returnReason = note;
      if (req.body?.completionEvidenceUrl) data.completionEvidenceUrl = nullableText(req.body.completionEvidenceUrl);
      if (nextStatus === 'closed') data.closedAt = new Date();
    } else if (kind === 'ticket') {
      if (nextStatus === 'rejected') data.rejectionReason = note;
      if (note) data.resolutionNote = note;
      if (nextStatus === 'closed') data.closedAt = new Date();
    } else if (kind === 'leave') {
      if (note) data.reviewerNote = note;
      if (nextStatus === 'rejected') data.rejectionReason = note;
      if (nextStatus === 'returned_for_edit') data.returnReason = note;
    } else if (kind === 'job') {
      if (note) data.internalNotes = note;
      if (req.body?.interviewAt) data.interviewAt = new Date(req.body.interviewAt);
    }

    const updated = await model.update({ where: { id: current.id }, data });
    await logMosqueWorkflowAction({ req, kind, item: updated, action: nextStatus === 'archived' ? 'archive' : 'status_change', fromStatus: current.status, toStatus: nextStatus, note, previousData: current, newData: updated });

    // Notify authenticated internal submitters when a decision requires their attention.
    const targetUserId = kind === 'request' ? current.submittedBy : kind === 'leave' ? current.applicantUserId : null;
    if (targetUserId && ['returned_for_edit', 'rejected', 'approved'].includes(nextStatus)) {
      const title = nextStatus === 'returned_for_edit' ? 'إجراء معاد للتعديل' : nextStatus === 'rejected' ? 'تم رفض الإجراء' : 'تم اعتماد الإجراء';
      await notify({ userId: targetUserId, siteId: current.siteId || null, title, message: `${workflowEntityLabel(kind, current, config)} — ${note || requestStatusLabels[nextStatus] || nextStatus}`, entityType: kind, entityId: current.id });
    }

    res.json(updated);
  } catch (error) { next(error); }
});

router.patch('/workflow/:kind/:id/resubmit', requireRoles('personnel'), async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    if (!['request', 'leave'].includes(kind)) return res.status(400).json({ message: 'إعادة الإرسال متاحة للطلبات والإجازات الداخلية فقط' });
    const config = getWorkflowConfig(kind);
    const model = prisma[config.model];
    const current = await model.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'الإجراء غير موجود' });
    if (current.status !== 'returned_for_edit') return res.status(400).json({ message: 'لا يمكن تعديل هذا الإجراء إلا بعد إعادته للتعديل' });

    const ownerId = kind === 'request' ? current.submittedBy : current.applicantUserId;
    if (!ownerId || ownerId !== req.authUser.id) return res.status(403).json({ message: 'لا يمكن تعديل إجراء مقدم من مستخدم آخر' });
    if (req.mosqueRole?.siteId && current.siteId !== req.mosqueRole.siteId) return res.status(403).json({ message: 'الإجراء لا يتبع الموقع المرتبط بحسابك' });

    const data = sanitizeWorkflowEdit(kind, req.body || {});
    data.status = kind === 'request' ? 'new' : 'pending';
    if (kind === 'request') {
      data.returnReason = null;
      data.rejectionReason = null;
      if (Array.isArray(req.body?.attachments) && req.body.attachments.length) data.attachments = req.body.attachments;
    } else {
      data.returnReason = null;
      data.rejectionReason = null;
      data.reviewerNote = null;
    }
    const updated = await model.update({ where: { id: current.id }, data });
    await logMosqueWorkflowAction({ req, kind, item: updated, action: 'resubmitted_after_return', fromStatus: current.status, toStatus: updated.status, note: nullableText(req.body?.resubmitNote) || 'تم تعديل الإجراء وإعادة إرساله', previousData: current, newData: updated });
    await notify({ roleTarget: 'supervisor', siteId: current.siteId, title: 'إجراء أعيد إرساله بعد التعديل', message: workflowEntityLabel(kind, updated, config), entityType: kind, entityId: current.id });
    res.json(updated);
  } catch (error) { next(error); }
});
'''

text = text.replace(marker, block + marker, 1)
path.write_text(text, encoding='utf-8')
print('Formal mosque workflow backend routes applied.')
