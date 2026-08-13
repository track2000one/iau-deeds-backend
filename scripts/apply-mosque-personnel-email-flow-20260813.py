from pathlib import Path

email_path = Path('src/services/email.service.js')
email_text = email_path.read_text(encoding='utf-8')

# Add a mosque-specific mail function without changing the generic activation mail used elsewhere.
if 'export async function sendMosquePersonnelActivationEmail' not in email_text:
    email_text += r'''

export async function sendMosquePersonnelActivationEmail({
  to,
  username,
  personnelRoleLabel,
  siteName,
  initialPassword,
  activationUrl,
  expiresInHours = 24,
  includePassword = true,
  loginUrl,
}) {
  const client = getBrevoClient();
  const senderEmail = process.env.EMAIL_FROM_ADDRESS;
  const senderName = process.env.EMAIL_FROM_NAME || "وحدة العناية بالمساجد والمصليات الجامعية";
  if (!senderEmail) throw new Error("EMAIL_FROM_ADDRESS is not configured");

  const safeUsername = escapeHtml(username || "المستخدم");
  const safeRole = escapeHtml(personnelRoleLabel || "منسوب مسجد أو مصلى");
  const safeSite = escapeHtml(siteName || "الموقع المرتبط");
  const safeActivationUrl = escapeHtml(activationUrl || '');
  const safeLoginUrl = escapeHtml(loginUrl || activationUrl || '');
  const safeEmail = escapeHtml(to);
  const safePassword = escapeHtml(initialPassword || "");

  const passwordHtml = includePassword ? `
    <div style="margin:22px 0;padding:18px;background:#f6f8fb;border:1px solid #d8e2ef;border-radius:12px">
      <p style="margin:0 0 10px"><strong>بيانات الدخول الأولية</strong></p>
      <p style="margin:7px 0">البريد الإلكتروني: <span dir="ltr">${safeEmail}</span></p>
      <p style="margin:7px 0">كلمة المرور الأولية:</p>
      <p dir="ltr" style="margin:10px 0 0;padding:12px;background:#fff;border-radius:8px;text-align:center;font-family:Consolas,monospace;font-size:17px;font-weight:bold;letter-spacing:1px">${safePassword}</p>
    </div>` : '';

  const actionUrl = includePassword ? safeActivationUrl : safeLoginUrl;
  const actionLabel = includePassword ? 'تفعيل الحساب' : 'الدخول إلى حساب منسوب المسجد';

  const result = await client.transactionalEmails.sendTransacEmail({
    sender: { email: senderEmail, name: senderName },
    to: [{ email: to, name: username || undefined }],
    subject: `حساب ${personnelRoleLabel || 'منسوب المسجد'} - وحدة العناية بالمساجد والمصليات الجامعية`,
    htmlContent: `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;background:#f3f6fa;font-family:Arial,Tahoma,sans-serif;color:#1f365f">
      <div style="max-width:640px;margin:30px auto;background:#fff;border:1px solid #d8e2ef;border-radius:16px;overflow:hidden">
        <div style="background:#203a78;padding:28px;color:#fff"><h2 style="margin:0 0 12px">وحدة العناية بالمساجد والمصليات الجامعية</h2><p style="margin:0">جامعة الإمام عبدالرحمن بن فيصل</p></div>
        <div style="padding:30px">
          <p>السلام عليكم ورحمة الله وبركاته،</p>
          <p>مرحبًا <strong>${safeUsername}</strong>، تم ${includePassword ? 'إنشاء' : 'ربط'} حسابك ضمن منظومة وحدة العناية بالمساجد والمصليات الجامعية.</p>
          <div style="margin:18px 0;padding:16px;background:#eef7ff;border:1px solid #cde7ff;border-radius:12px">
            <p style="margin:5px 0"><strong>الصفة:</strong> ${safeRole}</p>
            <p style="margin:5px 0"><strong>المسجد / الجامع / المصلى:</strong> ${safeSite}</p>
          </div>
          ${passwordHtml}
          <p>بعد الدخول ستظهر لك الصفحة المخصصة لمنسوبي المساجد حسب صلاحياتك، وتشمل بيانات موقعك وطلبات الصيانة والاحتياج والإجازة أو الاعتذار والإشعارات.</p>
          <div style="text-align:center;margin:30px 0"><a href="${actionUrl}" style="display:inline-block;background:#2454dc;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:bold">${actionLabel}</a></div>
          ${includePassword ? `<p>رابط التفعيل صالح لمدة <strong>${expiresInHours} ساعة</strong> ويعمل مرة واحدة فقط.</p><p style="font-size:13px;color:#667085">لن تتمكن من تسجيل الدخول قبل إكمال التفعيل.</p>` : '<p style="font-size:13px;color:#667085">يمكنك استخدام بيانات دخولك الحالية للوصول إلى واجهة منسوب المسجد.</p>'}
          <div style="margin-top:24px;padding:15px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;font-size:13px;color:#9a3412">لا تشارك كلمة المرور أو رابط التفعيل مع أي شخص.</div>
          <p style="margin-top:26px">مع تحياتنا،<br>وحدة العناية بالمساجد والمصليات الجامعية<br>جامعة الإمام عبدالرحمن بن فيصل</p>
        </div>
      </div>
    </body></html>`,
    textContent: `السلام عليكم ورحمة الله وبركاته\n\nمرحبًا ${username || 'المستخدم'}،\nتم ${includePassword ? 'إنشاء' : 'ربط'} حسابك ضمن وحدة العناية بالمساجد والمصليات الجامعية.\nالصفة: ${personnelRoleLabel || 'منسوب مسجد أو مصلى'}\nالموقع: ${siteName || '-'}\n${includePassword ? `البريد الإلكتروني: ${to}\nكلمة المرور الأولية: ${initialPassword}\nرابط التفعيل: ${activationUrl}\nالرابط صالح لمدة ${expiresInHours} ساعة.` : `رابط الدخول: ${loginUrl}`}\n\nبعد الدخول ستظهر لك الصفحة المخصصة لمنسوبي المساجد حسب صلاحياتك.`
  });
  console.log("Mosque personnel account email sent through Brevo:", result?.messageId || result?.body?.messageId);
  return result;
}
'''
    email_path.write_text(email_text, encoding='utf-8')

route_path = Path('src/routes/mosques.routes.js')
s = route_path.read_text(encoding='utf-8')
s = s.replace("import { sendAccountActivationEmail } from '../services/email.service.js';", "import { sendMosquePersonnelActivationEmail } from '../services/email.service.js';")

anchor = "const normalizeMosqueRole = (role) => role === 'viewer' ? 'university_member' : role;\n"
if 'const MOSQUE_PERSONNEL_ROLE_LABELS' not in s:
    labels = anchor + "const MOSQUE_PERSONNEL_ROLE_LABELS = { imam: 'إمام', muezzin: 'مؤذن', khateeb: 'خطيب', collaborating_khateeb: 'خطيب متعاون', collaborator: 'خطيب متعاون' };\n"
    if anchor not in s:
        raise RuntimeError('role label anchor not found')
    s = s.replace(anchor, labels, 1)

old = """    if (accountCreated) {\n      try {\n        await sendAccountActivationEmail({\n          to: user.email,\n          username: user.username,\n          initialPassword: temporaryPassword,\n          activationUrl: buildMosqueActivationUrl(activation.plainToken),\n          expiresInHours: MOSQUE_ACTIVATION_TOKEN_HOURS,\n          includePassword: true,\n        });\n      } catch (emailError) {\n        await prisma.mosquePersonnel.deleteMany({ where: { userId: user.id } });\n        await prisma.mosqueUserAssignment.deleteMany({ where: { userId: user.id } });\n        await prisma.appUser.delete({ where: { id: user.id } });\n        throw emailError;\n      }\n    }\n"""
new = """    const personnelRoleLabel = MOSQUE_PERSONNEL_ROLE_LABELS[input.role] || input.role;\n    const personnelSiteName = result.personnel?.site?.name || 'الموقع المرتبط';\n    const personnelLoginUrl = `${MOSQUE_FRONTEND_URL}/#/login`;\n\n    try {\n      await sendMosquePersonnelActivationEmail({\n        to: user.email,\n        username: user.username,\n        personnelRoleLabel,\n        siteName: personnelSiteName,\n        initialPassword: temporaryPassword,\n        activationUrl: accountCreated ? buildMosqueActivationUrl(activation.plainToken) : personnelLoginUrl,\n        loginUrl: personnelLoginUrl,\n        expiresInHours: MOSQUE_ACTIVATION_TOKEN_HOURS,\n        includePassword: accountCreated,\n      });\n    } catch (emailError) {\n      // الحساب الجديد لا يعتبر مكتمل الإنشاء دون نجاح إشعار التفعيل بالبريد.\n      if (accountCreated) {\n        await prisma.mosquePersonnel.deleteMany({ where: { userId: user.id } });\n        await prisma.mosqueUserAssignment.deleteMany({ where: { userId: user.id } });\n        await prisma.appUser.delete({ where: { id: user.id } });\n      }\n      throw emailError;\n    }\n"""
if old not in s:
    raise RuntimeError('personnel activation email block not found')
s = s.replace(old, new, 1)

old_msg = """      message: accountCreated\n        ? 'تم إنشاء حساب منسوب المسجد وربطه بالموقع وإرسال رابط التفعيل إلى بريده الإلكتروني.'\n        : 'تم ربط الحساب الموجود بالمسجد والصفة التشغيلية.',\n"""
new_msg = """      message: accountCreated\n        ? 'تم إنشاء حساب منسوب المسجد وربطه بالموقع وإرسال رابط التفعيل وبيانات الدخول إلى بريده الإلكتروني.'\n        : 'تم ربط الحساب الموجود بالمسجد والصفة التشغيلية وإرسال إشعار الدخول إلى بريده الإلكتروني.',\n"""
if old_msg not in s:
    raise RuntimeError('personnel response message block not found')
s = s.replace(old_msg, new_msg, 1)
route_path.write_text(s, encoding='utf-8')
