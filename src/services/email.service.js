import nodemailer from 'nodemailer';

const required = (name) => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required for password reset email.`);
  }

  return value;
};

const getTransporter = () => {
  const port = Number(process.env.SMTP_PORT || 587);

  return nodemailer.createTransport({
    host: required('SMTP_HOST'),
    port,
    secure:
      String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ||
      port === 465,
    auth: {
      user: required('SMTP_USER'),
      pass: required('SMTP_PASS'),
    },
    tls: {
      rejectUnauthorized:
        String(process.env.SMTP_REJECT_UNAUTHORIZED || 'true')
          .toLowerCase() !== 'false',
    },
  });
};

const escapeHtml = (value = '') =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

export const sendPasswordResetEmail = async ({
  to,
  username,
  resetUrl,
  expiresInMinutes,
}) => {
  const transporter = getTransporter();
  const from =
    process.env.SMTP_FROM?.trim() ||
    process.env.SMTP_USER?.trim();

  const safeUsername = escapeHtml(username || 'المستخدم');
  const safeResetUrl = escapeHtml(resetUrl);

  return transporter.sendMail({
    from,
    to,
    subject: 'إعادة تعيين كلمة المرور - منصة إدارة الصكوك والأراضي',
    text: [
      `مرحبًا ${username || 'المستخدم'}،`,
      '',
      'تلقينا طلبًا لإعادة تعيين كلمة المرور لحسابك.',
      `الرابط صالح لمدة ${expiresInMinutes} دقيقة ويعمل مرة واحدة فقط:`,
      resetUrl,
      '',
      'إذا لم تطلب إعادة تعيين كلمة المرور، فتجاهل هذه الرسالة.',
      '',
      'منصة إدارة الصكوك والأراضي',
      'جامعة الإمام عبدالرحمن بن فيصل',
    ].join('\n'),
    html: `
      <div dir="rtl" style="font-family:Arial,Tahoma,sans-serif;line-height:1.8;color:#172554;max-width:640px;margin:auto">
        <div style="border:1px solid #dbeafe;border-radius:18px;overflow:hidden;background:#ffffff">
          <div style="padding:24px;background:linear-gradient(135deg,#172554,#1e3a8a);color:#fff">
            <h1 style="margin:0;font-size:22px">إعادة تعيين كلمة المرور</h1>
            <p style="margin:8px 0 0;opacity:.85">منصة إدارة الصكوك والأراضي</p>
          </div>

          <div style="padding:28px">
            <p>مرحبًا <strong>${safeUsername}</strong>،</p>
            <p>تلقينا طلبًا لإعادة تعيين كلمة المرور لحسابك في المنصة.</p>

            <p style="margin:24px 0;text-align:center">
              <a href="${safeResetUrl}"
                 style="display:inline-block;padding:13px 24px;border-radius:10px;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:bold">
                إعادة تعيين كلمة المرور
              </a>
            </p>

            <p style="font-size:14px;color:#475569">
              الرابط صالح لمدة <strong>${expiresInMinutes} دقيقة</strong>
              ويعمل مرة واحدة فقط.
            </p>

            <p style="font-size:13px;color:#64748b;word-break:break-all">
              عند تعذر فتح الزر، انسخ الرابط التالي:<br>
              <a href="${safeResetUrl}">${safeResetUrl}</a>
            </p>

            <div style="margin-top:24px;padding:14px;border-radius:10px;background:#f8fafc;color:#475569;font-size:13px">
              إذا لم تطلب إعادة تعيين كلمة المرور، فتجاهل هذه الرسالة ولن تتغير كلمة مرورك.
            </div>
          </div>
        </div>
      </div>
    `,
  });
};

export const verifyEmailTransport = async () => {
  const transporter = getTransporter();
  return transporter.verify();
};
