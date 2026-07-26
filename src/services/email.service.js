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