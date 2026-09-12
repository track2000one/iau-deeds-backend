import { isDeepStrictEqual } from 'node:util';

export const ACCOUNTING_CONTROL_KEY = '__propertyControlAnalysis';
export const EVIDENCE_AUDIT_CONTEXT = 'لجنة متابعة متطلبات التحول المحاسبي';

const ALLOWED_EVENT_TYPES = new Set([
  'created',
  'status_changed',
  'responsible_changed',
  'due_date_changed',
  'priority_changed',
  'follow_up_status_changed',
  'action_logged',
  'attachment_uploaded',
  'closed',
  'note',
]);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
const cloneJson = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export class EvidenceAuditConflictError extends Error {
  constructor(message, code = 'EVIDENCE_AUDIT_IMMUTABLE') {
    super(message);
    this.name = 'EvidenceAuditConflictError';
    this.statusCode = 409;
    this.code = code;
  }
}

const checklistOf = (payload) => {
  const control = isObject(payload?.[ACCOUNTING_CONTROL_KEY]) ? payload[ACCOUNTING_CONTROL_KEY] : null;
  return isObject(control?.evidenceChecklist) ? control.evidenceChecklist : {};
};

const historyOf = (entry) => Array.isArray(entry?.history) ? entry.history : [];

const validateNewEvent = (event, requirementKey) => {
  if (!isObject(event)) {
    throw new EvidenceAuditConflictError(`حدث سجل الإثبات في «${requirementKey}» غير صالح.`, 'EVIDENCE_AUDIT_INVALID_EVENT');
  }
  const id = String(event.id || '').trim();
  const type = String(event.type || '').trim();
  const summary = String(event.summary || '').trim();
  const at = String(event.at || '').trim();
  if (!id || id.length > 220) {
    throw new EvidenceAuditConflictError('معرف حدث سجل الإثبات غير صالح.', 'EVIDENCE_AUDIT_INVALID_EVENT');
  }
  if (!ALLOWED_EVENT_TYPES.has(type)) {
    throw new EvidenceAuditConflictError(`نوع حدث سجل الإثبات «${type || 'غير محدد'}» غير مسموح.`, 'EVIDENCE_AUDIT_INVALID_EVENT');
  }
  if (!summary || summary.length > 5000) {
    throw new EvidenceAuditConflictError('وصف حدث سجل الإثبات غير صالح.', 'EVIDENCE_AUDIT_INVALID_EVENT');
  }
  if (!at || Number.isNaN(Date.parse(at))) {
    throw new EvidenceAuditConflictError('تاريخ حدث سجل الإثبات غير صالح.', 'EVIDENCE_AUDIT_INVALID_EVENT');
  }
};

const serverActorFields = (authUser) => ({
  actor: authUser?.username || authUser?.email || 'مستخدم المنصة',
  actorUserId: authUser?.id || undefined,
  actorEmail: authUser?.email || undefined,
  actorRole: authUser?.role || undefined,
  actorRoleLabel: authUser?.role === 'admin' ? 'مدير النظام' : 'موظف',
  actorContext: EVIDENCE_AUDIT_CONTEXT,
  source: 'user',
});

const stampNewEvent = (event, authUser, serverRecordedAt) => ({
  ...cloneJson(event),
  ...serverActorFields(authUser),
  serverRecordedAt,
});

const collectExistingIds = (checklist) => {
  const ids = new Set();
  for (const [requirementKey, entry] of Object.entries(checklist || {})) {
    for (const event of historyOf(entry)) {
      const id = String(event?.id || '').trim();
      if (!id) continue;
      if (ids.has(id)) {
        throw new EvidenceAuditConflictError(
          `يوجد معرف حدث مكرر محفوظ مسبقًا في سجل الإثبات: ${id}`,
          'EVIDENCE_AUDIT_DUPLICATE_ID'
        );
      }
      ids.add(id);
    }
  }
  return ids;
};

/**
 * Protects evidence history embedded in the accounting payload.
 * Existing events are immutable. New events are accepted only with fresh IDs,
 * validated, and stamped with the authenticated server-side identity.
 */
export const protectEvidenceAuditPayload = (
  previousPayload = {},
  incomingPayload = {},
  authUser = null,
  options = {}
) => {
  const allowNewEvents = options.allowNewEvents !== false;
  const serverRecordedAt = options.serverRecordedAt || new Date().toISOString();
  const previous = isObject(previousPayload) ? cloneJson(previousPayload) : {};
  const incoming = isObject(incomingPayload) ? cloneJson(incomingPayload) : {};
  const previousControl = isObject(previous[ACCOUNTING_CONTROL_KEY]) ? previous[ACCOUNTING_CONTROL_KEY] : null;
  const incomingHasControl = hasOwn(incoming, ACCOUNTING_CONTROL_KEY);

  // An omitted control section means the caller is not editing it. Preserve it.
  if (!incomingHasControl) {
    if (previousControl) incoming[ACCOUNTING_CONTROL_KEY] = cloneJson(previousControl);
    return { payload: incoming, newEvents: [] };
  }

  const incomingControl = incoming[ACCOUNTING_CONTROL_KEY];
  if (!isObject(incomingControl)) {
    if (previousControl) {
      throw new EvidenceAuditConflictError('لا يمكن حذف أو استبدال بيانات السجل الرقابي لمستندات الإثبات.');
    }
    delete incoming[ACCOUNTING_CONTROL_KEY];
    return { payload: incoming, newEvents: [] };
  }

  const previousChecklist = checklistOf(previous);
  const incomingChecklistProvided = hasOwn(incomingControl, 'evidenceChecklist');
  const incomingChecklist = incomingChecklistProvided && isObject(incomingControl.evidenceChecklist)
    ? incomingControl.evidenceChecklist
    : null;

  // Older/non-audit clients may update other analysis fields without sending the checklist.
  // Preserve the checklist rather than allowing an accidental deletion.
  if (!incomingChecklist) {
    if (Object.keys(previousChecklist).length) {
      incomingControl.evidenceChecklist = cloneJson(previousChecklist);
    }
    incoming[ACCOUNTING_CONTROL_KEY] = incomingControl;
    return { payload: incoming, newEvents: [] };
  }

  const existingIds = collectExistingIds(previousChecklist);
  const newIds = new Set();
  const newEvents = [];
  const resultChecklist = cloneJson(incomingChecklist);
  const requirementKeys = new Set([...Object.keys(previousChecklist), ...Object.keys(incomingChecklist)]);

  for (const requirementKey of requirementKeys) {
    const previousEntry = isObject(previousChecklist[requirementKey]) ? previousChecklist[requirementKey] : null;
    const incomingEntry = isObject(incomingChecklist[requirementKey]) ? incomingChecklist[requirementKey] : null;
    const previousHistory = historyOf(previousEntry);

    if (previousEntry && !incomingEntry) {
      if (previousHistory.length) {
        throw new EvidenceAuditConflictError(`لا يمكن حذف مهمة الإثبات «${requirementKey}» لأنها تحتوي على سجل رقابي محفوظ.`);
      }
      continue;
    }
    if (!incomingEntry) continue;

    // If history is omitted, preserve the immutable server copy for compatibility.
    if (!hasOwn(incomingEntry, 'history')) {
      if (previousHistory.length) resultChecklist[requirementKey].history = cloneJson(previousHistory);
      continue;
    }

    const incomingHistory = Array.isArray(incomingEntry.history) ? incomingEntry.history : [];
    const incomingById = new Map();
    for (const event of incomingHistory) {
      const id = String(event?.id || '').trim();
      if (id && incomingById.has(id)) {
        throw new EvidenceAuditConflictError(`تم إرسال معرف حدث مكرر: ${id}`, 'EVIDENCE_AUDIT_DUPLICATE_ID');
      }
      if (id) incomingById.set(id, event);
    }

    for (const previousEvent of previousHistory) {
      const id = String(previousEvent?.id || '').trim();
      const candidate = id ? incomingById.get(id) : undefined;
      if (!candidate) {
        throw new EvidenceAuditConflictError(`لا يمكن حذف الحدث الرقابي «${id || 'بدون معرف'}» من مستند «${requirementKey}».`);
      }
      if (!isDeepStrictEqual(previousEvent, candidate)) {
        throw new EvidenceAuditConflictError(`لا يمكن تعديل محتوى الحدث الرقابي «${id}» بعد حفظه.`);
      }
    }

    const appended = [];
    for (const candidate of incomingHistory) {
      const id = String(candidate?.id || '').trim();
      if (id && existingIds.has(id)) continue;
      validateNewEvent(candidate, requirementKey);
      if (newIds.has(id)) {
        throw new EvidenceAuditConflictError(`معرف الحدث الجديد «${id}» مستخدم أكثر من مرة.`, 'EVIDENCE_AUDIT_DUPLICATE_ID');
      }
      if (!allowNewEvents) {
        throw new EvidenceAuditConflictError('لا يسمح مسار الاستيراد بإضافة أحداث سجل رقابي من بيانات الملف.', 'EVIDENCE_AUDIT_IMPORT_BLOCKED');
      }
      newIds.add(id);
      const stamped = stampNewEvent(candidate, authUser, serverRecordedAt);
      appended.push(stamped);
      newEvents.push({ requirementKey, event: stamped });
    }

    resultChecklist[requirementKey].history = [...cloneJson(previousHistory), ...appended];
  }

  incomingControl.evidenceChecklist = resultChecklist;
  incoming[ACCOUNTING_CONTROL_KEY] = incomingControl;
  return { payload: incoming, newEvents };
};

/**
 * Spreadsheet/cycle imports may update accounting columns, but must never write
 * or erase the protected control-analysis section. The server copy always wins.
 */
export const preserveEvidenceControlForImport = (existingPayload = {}, incomingPayload = {}) => {
  const incoming = isObject(incomingPayload) ? cloneJson(incomingPayload) : {};
  const existingControl = isObject(existingPayload?.[ACCOUNTING_CONTROL_KEY])
    ? cloneJson(existingPayload[ACCOUNTING_CONTROL_KEY])
    : null;
  if (existingControl) incoming[ACCOUNTING_CONTROL_KEY] = existingControl;
  else delete incoming[ACCOUNTING_CONTROL_KEY];
  return incoming;
};

export const hasProtectedEvidenceHistory = (payload = {}) =>
  Object.values(checklistOf(payload)).some((entry) => historyOf(entry).length > 0);

export const listEvidenceAuditEvents = (payload = {}) => {
  const events = [];
  for (const [requirementKey, entry] of Object.entries(checklistOf(payload))) {
    for (const event of historyOf(entry)) {
      if (!isObject(event) || !event.id) continue;
      events.push({ requirementKey, event });
    }
  }
  return events;
};

/**
 * Builds append-only mirror rows for the generic AuditLog table. There are no
 * update/delete API routes for AuditLog, so this provides a second DB-resident
 * trace that survives accounting-record deletion/reset operations.
 */
export const buildEvidenceAuditMirrorRows = (record, payload = {}) =>
  listEvidenceAuditEvents(payload).map(({ requirementKey, event }) => ({
    mirrorId: `${record.id}:${event.id}`,
    data: {
      userId: event.actorUserId || null,
      username: event.actor || null,
      userEmail: event.actorEmail || null,
      userRole: event.actorRole || null,
      action: 'evidence_history_append',
      module: 'accounting_transformation',
      entity: 'accounting_evidence_event',
      entityId: `${record.id}:${event.id}`,
      entityLabel: `${record.recordNumber || record.id} · ${requirementKey}`,
      status: 'success',
      description: String(event.summary || 'حدث في سجل مستندات الإثبات').slice(0, 5000),
      newData: { ...cloneJson(event), requirementKey },
      metadata: {
        recordId: record.id,
        recordNumber: record.recordNumber || null,
        requirementKey,
        eventId: event.id,
        eventAt: event.at || null,
        serverRecordedAt: event.serverRecordedAt || null,
        source: event.source || null,
        protectedEvidenceAudit: true,
      },
    },
  }));
