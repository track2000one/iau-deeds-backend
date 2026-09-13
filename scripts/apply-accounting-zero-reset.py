from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'Expected block not found in {path}: {old[:160]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

route = 'src/routes/accounting-baseline-reset.routes.js'
replace_once(
    route,
    "const CONFIRMATION_PHRASE = 'إعادة تأسيس بيانات اللجنة';\n",
    "const CONFIRMATION_PHRASE = 'إعادة تأسيس بيانات اللجنة';\nconst ZERO_CONFIRMATION_PHRASE = 'تصفير سجل الأصول ومتطلبات التحول';\n",
)

replace_once(
    route,
    """const resetSchema = previewSchema.extend({\n  confirmation: z.string().trim(),\n  cycleName: z.string().trim().min(3).max(180).default(DEFAULT_BASELINE_NAME),\n  expectedImpact: z.object({\n    cycles: z.number().int().nonnegative(),\n    records: z.number().int().nonnegative(),\n    cycleTemplateSnapshots: z.number().int().nonnegative(),\n  }),\n  expectedDatasetFingerprint: z.string().trim().min(32).max(128),\n});\n""",
    """const resetSchema = previewSchema.extend({\n  confirmation: z.string().trim(),\n  cycleName: z.string().trim().min(3).max(180).default(DEFAULT_BASELINE_NAME),\n  expectedImpact: z.object({\n    cycles: z.number().int().nonnegative(),\n    records: z.number().int().nonnegative(),\n    cycleTemplateSnapshots: z.number().int().nonnegative(),\n  }),\n  expectedDatasetFingerprint: z.string().trim().min(32).max(128),\n});\n\nconst zeroResetSchema = z.object({\n  confirmation: z.string().trim(),\n  expectedImpact: z.object({\n    cycles: z.number().int().nonnegative(),\n    records: z.number().int().nonnegative(),\n    cycleTemplateSnapshots: z.number().int().nonnegative(),\n  }),\n});\n""",
)

anchor = "router.post('/reset-baseline/preview', async (req, res, next) => {\n"
zero_routes = r"""router.post('/reset-empty/preview', async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'admin') {
      return res.status(403).json({ message: 'معاينة تصفير سجل الأصول ومتطلبات التحول متاحة لمسؤول النظام فقط.' });
    }
    const impact = await getImpact();
    return res.json({
      confirmationPhrase: ZERO_CONFIRMATION_PHRASE,
      impact,
      resultAfterReset: { cycles: 0, records: 0, cycleTemplateSnapshots: 0 },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-empty', async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'admin') {
      return res.status(403).json({ message: 'تصفير سجل الأصول ومتطلبات التحول متاح لمسؤول النظام فقط.' });
    }

    const input = zeroResetSchema.parse(req.body);
    if (input.confirmation !== ZERO_CONFIRMATION_PHRASE) {
      return res.status(400).json({ message: `اكتب عبارة التأكيد حرفيًا: ${ZERO_CONFIRMATION_PHRASE}` });
    }

    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const transactionResult = await prisma.$transaction(async (tx) => {
      const liveImpact = await getImpact(tx);
      if (!impactMatches(input.expectedImpact, liveImpact.destructive)) {
        const staleError = new Error('STALE_ZERO_IMPACT');
        staleError.code = 'STALE_ZERO_IMPACT';
        staleError.liveImpact = liveImpact;
        throw staleError;
      }

      await tx.accountingCycleTemplateSnapshot.deleteMany({});
      await tx.accountingTransformationRecord.deleteMany({});
      await tx.accountingTransformationCycle.deleteMany({});

      await tx.auditLog.create({
        data: {
          userId: req.authUser?.id || null,
          username: req.authUser?.username || null,
          userEmail: req.authUser?.email || null,
          userRole: req.authUser?.role || null,
          action: 'zero_accounting_transformation_records',
          module: 'accounting_transformation',
          entity: 'accounting_transformation',
          entityId: 'accounting-transformation-zero',
          entityLabel: 'سجل الأصول ومتطلبات التحول',
          status: 'success',
          description: `تصفير سجل الأصول ومتطلبات التحول: حذف ${liveImpact.destructive.records} سجل و${liveImpact.destructive.cycles} دورة و${liveImpact.destructive.cycleTemplateSnapshots} لقطة دورة، مع الإبقاء على المستخدمين والصلاحيات وسجل التدقيق والنماذج الرسمية.`,
          previousData: liveImpact,
          newData: {
            cycles: 0,
            records: 0,
            cycleTemplateSnapshots: 0,
            preserved: liveImpact.preserved,
          },
          ipAddress,
          userAgent,
        },
      });

      return liveImpact;
    }, { timeout: 120000, isolationLevel: 'Serializable' });

    return res.json({
      message: 'تم تصفير سجل الأصول ومتطلبات التحول بنجاح. السجل الآن فارغ وجاهز لإدخال بيانات جديدة.',
      deleted: transactionResult.destructive,
      preserved: transactionResult.preserved,
      remaining: { cycles: 0, records: 0, cycleTemplateSnapshots: 0 },
    });
  } catch (error) {
    if (error?.code === 'STALE_ZERO_IMPACT' || error?.message === 'STALE_ZERO_IMPACT') {
      return res.status(409).json({
        message: 'تغيرت بيانات السجل منذ آخر معاينة. لم يتم حذف أي شيء. أعد المعاينة ثم حاول مرة أخرى.',
        impact: error.liveImpact || null,
      });
    }
    next(error);
  }
});

"""
replace_once(route, anchor, zero_routes + anchor)

service = 'src/services/accountingCycles.service.js'
replace_once(
    service,
    """  if (!current && cycleCount === 0) {\n    current = await prisma.accountingTransformationCycle.create({\n""",
    """  if (!current && cycleCount === 0) {\n    const explicitZero = await prisma.auditLog.findFirst({\n      where: {\n        module: 'accounting_transformation',\n        action: 'zero_accounting_transformation_records',\n        status: 'success',\n      },\n      orderBy: { createdAt: 'desc' },\n      select: { id: true },\n    });\n    // A deliberate administrator reset must survive service restarts. New installs\n    // still receive the historical bootstrap cycle because no zero-reset marker exists.\n    if (explicitZero) return null;\n\n    current = await prisma.accountingTransformationCycle.create({\n""",
)

print('Applied standalone accounting zero reset backend changes.')
