import { BrevoClient } from "@getbrevo/brevo";

function getBrevoClient() {
  const apiKey = process.env.BREVO_API_KEY;

  if (!apiKey) {
    throw new Error("BREVO_API_KEY is not configured");
  }

  return new BrevoClient({
    apiKey,
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendPasswordResetEmail({
  to,
  username,
  resetUrl,
  expiresInMinutes = 30,
}) {
  const client = getBrevoClient();

  const senderEmail = process.env.EMAIL_FROM_ADDRESS;
  const senderName =
    process.env.EMAIL_FROM_NAME ||
    "منصة إدارة الصكوك والأراضي";

  if (!senderEmail) {
    throw new Error("EMAIL_FROM_ADDRESS is not configured");
  }

  const safeUsername = escapeHtml(username || "المستخدم");
  const safeResetUrl = escapeHtml(resetUrl);

  const result =
    await client.transactionalEmails.sendTransacEmail({
      sender: {
        email: senderEmail,
        name: senderName,
      },

      to: [
        {
          email: to,
          name: username || undefined,
        },
      ],

      subject:
        "إعادة تعيين كلمة المرور - منصة إدارة الصكوك والأراضي",

      htmlContent: `
        <!doctype html>
        <html lang="ar" dir="rtl">
          <head>
            <meta charset="utf-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />
          </head>

          <body
            style="
              margin:0;
              background:#f3f6fa;
              font-family:Arial,Tahoma,sans-serif;
              color:#1f365f;
            "
          >
            <div
              style="
                max-width:640px;
                margin:30px auto;
                background:#ffffff;
                border:1px solid #d8e2ef;
                border-radius:16px;
                overflow:hidden;
              "
            >
              <div
                style="
                  background:#203a78;
                  padding:28px;
                  color:#ffffff;
                "
              >
                <h2 style="margin:0 0 12px;">
                  إعادة تعيين كلمة المرور
                </h2>

                <p style="margin:0;">
                  منصة إدارة الصكوك والأراضي
                </p>
              </div>

              <div style="padding:30px;">
                <p>
                  مرحبًا
                  <strong>${safeUsername}</strong>،
                </p>

                <p>
                  تلقينا طلبًا لإعادة تعيين كلمة المرور
                  لحسابك في المنصة.
                </p>

                <div
                  style="
                    text-align:center;
                    margin:32px 0;
                  "
                >
                  <a
                    href="${safeResetUrl}"
                    style="
                      display:inline-block;
                      background:#2454dc;
                      color:#ffffff;
                      text-decoration:none;
                      padding:14px 24px;
                      border-radius:10px;
                      font-weight:bold;
                    "
                  >
                    إعادة تعيين كلمة المرور
                  </a>
                </div>

                <p>
                  الرابط صالح لمدة
                  <strong>${expiresInMinutes} دقيقة</strong>
                  ويعمل مرة واحدة فقط.
                </p>

                <p
                  style="
                    font-size:13px;
                    color:#667085;
                  "
                >
                  إذا تعذر الضغط على الزر، انسخ الرابط التالي:
                </p>

                <p
                  style="
                    font-size:12px;
                    direction:ltr;
                    text-align:left;
                    word-break:break-all;
                  "
                >
                  <a href="${safeResetUrl}">
                    ${safeResetUrl}
                  </a>
                </p>

                <div
                  style="
                    margin-top:24px;
                    padding:15px;
                    background:#f6f8fb;
                    border-radius:10px;
                    font-size:13px;
                  "
                >
                  إذا لم تطلب إعادة تعيين كلمة المرور،
                  فتجاهل هذه الرسالة.
                </div>
              </div>
            </div>
          </body>
        </html>
      `,

      textContent: `
مرحبًا ${username || "المستخدم"}

تلقينا طلبًا لإعادة تعيين كلمة المرور لحسابك.

رابط إعادة التعيين:
${resetUrl}

الرابط صالح لمدة ${expiresInMinutes} دقيقة
ويعمل مرة واحدة فقط.

إذا لم تطلب إعادة تعيين كلمة المرور،
فتجاهل هذه الرسالة.
      `.trim(),
    });

  console.log(
    "Password reset email sent through Brevo:",
    result?.messageId || result?.body?.messageId
  );

  return result;
}

export async function verifyEmailTransport() {
  getBrevoClient();

  console.log("Brevo API key is configured.");

  return true;
}

export async function sendAccountActivationEmail({
  to,
  username,
  initialPassword,
  activationUrl,
  expiresInHours = 24,
  includePassword = true,
}) {
  const client = getBrevoClient();

  const senderEmail = process.env.EMAIL_FROM_ADDRESS;
  const senderName =
    process.env.EMAIL_FROM_NAME ||
    "منصة إدارة الصكوك والأراضي";

  if (!senderEmail) {
    throw new Error("EMAIL_FROM_ADDRESS is not configured");
  }

  const safeUsername = escapeHtml(username || "المستخدم");
  const safeActivationUrl = escapeHtml(activationUrl);
  const safeEmail = escapeHtml(to);
  const safePassword = escapeHtml(initialPassword || "");

  const passwordSection = includePassword
    ? `
      <div
        style="
          margin:22px 0;
          padding:18px;
          background:#f6f8fb;
          border:1px solid #d8e2ef;
          border-radius:12px;
        "
      >
        <p style="margin:0 0 10px;">
          <strong>بيانات الدخول الأولية</strong>
        </p>

        <p style="margin:7px 0;">
          البريد الإلكتروني:
          <span dir="ltr">${safeEmail}</span>
        </p>

        <p style="margin:7px 0;">
          كلمة المرور التي أنشأها المسؤول:
        </p>

        <p
          dir="ltr"
          style="
            margin:10px 0 0;
            padding:12px;
            background:#ffffff;
            border-radius:8px;
            text-align:center;
            font-family:Consolas,monospace;
            font-size:17px;
            font-weight:bold;
            letter-spacing:1px;
          "
        >
          ${safePassword}
        </p>
      </div>
    `
    : `
      <div
        style="
          margin:22px 0;
          padding:16px;
          background:#f6f8fb;
          border-radius:10px;
          font-size:14px;
        "
      >
        استخدم كلمة المرور الأولية التي سبق أن أرسلها لك مسؤول النظام.
      </div>
    `;

  const textPasswordSection = includePassword
    ? `
البريد الإلكتروني: ${to}
كلمة المرور الأولية: ${initialPassword}
`
    : `
استخدم كلمة المرور الأولية التي سبق أن أرسلها لك مسؤول النظام.
`;

  const result =
    await client.transactionalEmails.sendTransacEmail({
      sender: {
        email: senderEmail,
        name: senderName,
      },

      to: [
        {
          email: to,
          name: username || undefined,
        },
      ],

      subject:
        "تفعيل حسابك - منصة إدارة الصكوك والأراضي",

      htmlContent: `
        <!doctype html>
        <html lang="ar" dir="rtl">
          <head>
            <meta charset="utf-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />
          </head>

          <body
            style="
              margin:0;
              background:#f3f6fa;
              font-family:Arial,Tahoma,sans-serif;
              color:#1f365f;
            "
          >
            <div
              style="
                max-width:640px;
                margin:30px auto;
                background:#ffffff;
                border:1px solid #d8e2ef;
                border-radius:16px;
                overflow:hidden;
              "
            >
              <div
                style="
                  background:#203a78;
                  padding:28px;
                  color:#ffffff;
                "
              >
                <h2 style="margin:0 0 12px;">
                  مرحبًا بك
                </h2>

                <p style="margin:0;">
                  منصة إدارة الصكوك والأراضي
                </p>
              </div>

              <div style="padding:30px;">
                <p>
                  السلام عليكم ورحمة الله وبركاته،
                </p>

                <p>
                  مرحبًا
                  <strong>${safeUsername}</strong>،
                  قام مسؤول النظام بإنشاء حساب لك في المنصة.
                </p>

                ${passwordSection}

                <p>
                  يرجى الضغط على الزر التالي لتفعيل الحساب.
                  بعد فتح الرابط يمكنك الاحتفاظ بكلمة المرور الحالية
                  أو تعيين كلمة مرور جديدة.
                </p>

                <div
                  style="
                    text-align:center;
                    margin:32px 0;
                  "
                >
                  <a
                    href="${safeActivationUrl}"
                    style="
                      display:inline-block;
                      background:#2454dc;
                      color:#ffffff;
                      text-decoration:none;
                      padding:14px 28px;
                      border-radius:10px;
                      font-weight:bold;
                    "
                  >
                    تفعيل الحساب
                  </a>
                </div>

                <p>
                  رابط التفعيل صالح لمدة
                  <strong>${expiresInHours} ساعة</strong>
                  ويعمل مرة واحدة فقط.
                </p>

                <p
                  style="
                    font-size:13px;
                    color:#667085;
                  "
                >
                  لن تتمكن من تسجيل الدخول قبل إكمال عملية التفعيل.
                </p>

                <p
                  style="
                    font-size:12px;
                    direction:ltr;
                    text-align:left;
                    word-break:break-all;
                  "
                >
                  <a href="${safeActivationUrl}">
                    ${safeActivationUrl}
                  </a>
                </p>

                <div
                  style="
                    margin-top:24px;
                    padding:15px;
                    background:#fff7ed;
                    border:1px solid #fed7aa;
                    border-radius:10px;
                    font-size:13px;
                    color:#9a3412;
                  "
                >
                  لا تشارك كلمة المرور أو رابط التفعيل مع أي شخص.
                </div>

                <p style="margin-top:26px;">
                  مع تحياتنا،<br />
                  إدارة أوقاف وأملاك الجامعة<br />
                  جامعة الإمام عبدالرحمن بن فيصل
                </p>
              </div>
            </div>
          </body>
        </html>
      `,

      textContent: `
السلام عليكم ورحمة الله وبركاته،

مرحبًا ${username || "المستخدم"}،

قام مسؤول النظام بإنشاء حساب لك في منصة إدارة الصكوك والأراضي.
${textPasswordSection}
رابط تفعيل الحساب:
${activationUrl}

بعد فتح الرابط يمكنك الاحتفاظ بكلمة المرور الحالية
أو تعيين كلمة مرور جديدة.

الرابط صالح لمدة ${expiresInHours} ساعة ويعمل مرة واحدة فقط.
لن تتمكن من تسجيل الدخول قبل إكمال التفعيل.
      `.trim(),
    });

  console.log(
    "Account activation email sent through Brevo:",
    result?.messageId || result?.body?.messageId
  );

  return result;
}



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
