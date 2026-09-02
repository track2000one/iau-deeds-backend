from pathlib import Path

path = Path('src/routes/mosques.routes.js')
source = path.read_text(encoding='utf-8')


def replace_once(old: str, new: str, label: str):
    global source
    if old not in source:
        raise RuntimeError(f'{label} marker not found')
    source = source.replace(old, new, 1)

replace_once(
"""  attachments: z.array(fieldVisitImageSchema).max(100).optional().default([]),
  items: z.array(fieldVisitItemSchema).default([]),
});

const FIELD_VISIT_CHECKLIST = [""",
"""  attachments: z.array(fieldVisitImageSchema).max(100).optional().default([]),
  items: z.array(fieldVisitItemSchema).default([]),
});

const validateFieldVisitTreatmentEvidence = (input) => {
  const requiresBeforeEvidence = ['completed', 'follow_up', 'closed'].includes(input.workflowStatus);
  for (const item of input.items || []) {
    if (item.status !== 'needs_action') continue;
    if (!nullableText(item.note)) {
      const error = new Error(`وصف الملاحظة إلزامي في بند: ${item.title}`);
      error.statusCode = 400;
      throw error;
    }
    if (requiresBeforeEvidence && !(item.beforeImages || []).length) {
      const error = new Error(`صورة قبل المعالجة إلزامية في بند: ${item.title}`);
      error.statusCode = 400;
      throw error;
    }
    if (['resolved', 'closed'].includes(item.resolutionStatus) && !nullableText(item.resolutionNote)) {
      const error = new Error(`وصف الإجراء أو المعالجة المنفذة إلزامي في بند: ${item.title}`);
      error.statusCode = 400;
      throw error;
    }
    if (item.resolutionStatus === 'closed' && !(item.afterImages || []).length) {
      const error = new Error(`صورة بعد المعالجة إلزامية قبل إغلاق الملاحظة في بند: ${item.title}`);
      error.statusCode = 400;
      throw error;
    }
  }
};

const FIELD_VISIT_CHECKLIST = [""",
'validation helper',
)

replace_once(
"""    const context = req.mosqueRole || await getModuleRole(req);
    const input = fieldVisitSchema.parse(req.body);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, context);""",
"""    const context = req.mosqueRole || await getModuleRole(req);
    const input = fieldVisitSchema.parse(req.body);
    validateFieldVisitTreatmentEvidence(input);
    if (context.role === 'supervisor') await assertSupervisorSiteAccess(req, input.siteId, context);""",
'create field visit validation call',
)

replace_once(
"""    const input = fieldVisitSchema.parse(req.body);
    if (ACTIVE_FIELD_VISIT_STATUSES.includes(input.workflowStatus)) {""",
"""    const input = fieldVisitSchema.parse(req.body);
    validateFieldVisitTreatmentEvidence(input);
    if (ACTIVE_FIELD_VISIT_STATUSES.includes(input.workflowStatus)) {""",
'update field visit validation call',
)

path.write_text(source, encoding='utf-8')
print('Applied field visit treatment evidence validation.')
