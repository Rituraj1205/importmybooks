import nodemailer from "nodemailer";
import { logError } from "./logger.js";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || `"ImportMyBooks" <${SMTP_USER}>`;

const isConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

let _transporter = null;
function getTransporter() {
  if (!isConfigured) return null;
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return _transporter;
}

async function sendMail({ to, subject, html, text }) {
  if (!isConfigured) {
    console.log(`[Email] SMTP not configured — skipping email to ${to}: ${subject}`);
    return { skipped: true };
  }
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({ from: SMTP_FROM, to, subject, html, text });
    console.log(`[Email] Sent to ${to}: ${subject} (${info.messageId})`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    logError("emailService.sendMail", err, { to, subject });
    return { error: err.message };
  }
}

export async function sendPasswordResetEmail(email, tempPassword) {
  return sendMail({
    to: email,
    subject: "ImportMyBooks — Your Temporary Password",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 16px;">Your temporary password</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;">
          An admin has reset your password. Use the temporary password below to log in, then change it immediately from your account settings.
        </p>
        <div style="background:#0d9488;color:#fff;font-size:20px;font-weight:700;font-family:monospace;padding:14px 20px;border-radius:8px;letter-spacing:2px;text-align:center;margin-bottom:20px;">
          ${tempPassword}
        </div>
        <p style="font-size:12px;color:#4e6082;line-height:1.6;">
          If you didn't request this, contact your administrator immediately.
        </p>
      </div>
    `,
    text: `Your ImportMyBooks temporary password is: ${tempPassword}\n\nLog in and change it immediately.`,
  });
}

export async function sendWelcomeEmail(email, role) {
  return sendMail({
    to: email,
    subject: "Welcome to ImportMyBooks — Your account is ready",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 16px;">Welcome aboard 👋</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 16px;">
          Your ImportMyBooks account has been created with role: <strong style="color:#e8f0fd;">${role}</strong>.
        </p>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;">
          Log in with your email <strong style="color:#e8f0fd;">${email}</strong> and the password provided by your administrator.
        </p>
        <p style="font-size:12px;color:#4e6082;">Need help? Reply to this email or check the Template Guide inside the app.</p>
      </div>
    `,
    text: `Welcome to ImportMyBooks! Your account (${email}) is ready. Role: ${role}.`,
  });
}

export async function sendImportCompleteEmail(email, importType, total, created, errors) {
  const status = errors > 0 ? `⚠️ Completed with ${errors} error(s)` : "✅ Completed successfully";
  return sendMail({
    to: email,
    subject: `ImportMyBooks Import ${errors > 0 ? "completed with errors" : "successful"} — ${importType}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 4px;">${status}</h2>
        <p style="font-size:13px;color:#4e6082;margin:0 0 20px;">${importType} import</p>
        <div style="display:flex;gap:12px;margin-bottom:20px;">
          <div style="flex:1;background:#0d9488;border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${created}</div>
            <div style="font-size:11px;opacity:0.8;">Created</div>
          </div>
          <div style="flex:1;background:${errors > 0 ? "#dc2626" : "#166534"};border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${errors}</div>
            <div style="font-size:11px;opacity:0.8;">Errors</div>
          </div>
          <div style="flex:1;background:#1e3a5f;border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:24px;font-weight:800;">${total}</div>
            <div style="font-size:11px;opacity:0.8;">Total</div>
          </div>
        </div>
        <p style="font-size:12px;color:#4e6082;">Log in to ImportMyBooks to view detailed results and download the error report.</p>
      </div>
    `,
    text: `ImportMyBooks Import — ${importType}\nStatus: ${status}\nCreated: ${created} | Errors: ${errors} | Total: ${total}`,
  });
}

export async function sendPlanApprovedEmail(email, planName) {
  const label = planName === "testing" ? "Testing (Free)" : planName.charAt(0).toUpperCase() + planName.slice(1);
  return sendMail({
    to: email,
    subject: `ImportMyBooks — Your ${label} plan is now active`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 12px;">✅ Your plan is active!</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 16px;">
          Your <strong style="color:#e8f0fd;">${label}</strong> plan has been approved and activated.
          You can now log in to ImportMyBooks and start importing.
        </p>
        <p style="font-size:12px;color:#4e6082;">Need help getting started? Reply to this email — we respond within a few hours.</p>
      </div>
    `,
    text: `Your ImportMyBooks ${label} plan is now active. Log in to start importing.`,
  });
}

export async function sendPaymentReceivedEmail(email, planName, expiry) {
  const label = planName.charAt(0).toUpperCase() + planName.slice(1);
  const expiryFormatted = expiry ? new Date(expiry).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : expiry;
  return sendMail({
    to: email,
    subject: `ImportMyBooks — Your ${label} plan is now active!`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <div style="width:52px;height:52px;border-radius:50%;background:rgba(45,212,191,0.12);border:2px solid rgba(45,212,191,0.4);display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:18px;">✓</div>
        <h2 style="font-size:20px;margin:0 0 12px;font-weight:800;">Payment confirmed. You're all set!</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 16px;">
          Your <strong style="color:#2dd4bf;">${label} Plan</strong> is now active. You have full access to ImportMyBooks — no further steps needed.
        </p>
        <div style="background:#0d1e35;border:1px solid rgba(45,212,191,0.2);border-radius:10px;padding:16px 20px;margin-bottom:20px;">
          <div style="font-size:12px;color:#4e6082;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;">Plan expires</div>
          <div style="font-size:16px;font-weight:700;color:#e8f0fd;">${expiryFormatted}</div>
        </div>
        <a href="https://prism.importmybooks.com/import" style="display:inline-block;padding:12px 28px;background:#2dd4bf;color:#071929;font-weight:700;font-size:14px;border-radius:8px;text-decoration:none;margin-bottom:20px;">Go to ImportMyBooks →</a>
        <p style="font-size:12px;color:#4e6082;line-height:1.6;">If you have any questions, reply to this email or contact support@importmybooks.com</p>
      </div>
    `,
    text: `Your ImportMyBooks ${label} plan is now active! Plan expires: ${expiryFormatted}. Login at prism.importmybooks.com`,
  });
}

export async function sendForgotPasswordEmail(email, tempPassword) {
  return sendMail({
    to: email,
    subject: "ImportMyBooks — Password Reset",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 16px;">🔑 Password reset</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;">
          You requested a password reset. Use this temporary password to log in:
        </p>
        <div style="background:#0d9488;color:#fff;font-size:20px;font-weight:700;font-family:monospace;padding:14px 20px;border-radius:8px;letter-spacing:2px;text-align:center;margin-bottom:20px;">
          ${tempPassword}
        </div>
        <p style="font-size:12px;color:#4e6082;line-height:1.6;">
          This password expires in 24 hours. If you didn't request this, ignore this email — your account remains secure.
        </p>
      </div>
    `,
    text: `Your ImportMyBooks temporary password: ${tempPassword}\n\nThis expires in 24 hours.`,
  });
}

export async function sendPlanExpiryWarningEmail(email, planName, daysLeft, expiryDate) {
  const label = planName.charAt(0).toUpperCase() + planName.slice(1);
  return sendMail({
    to: email,
    subject: `ImportMyBooks — Your ${label} plan expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 12px;">⏰ Plan expiring soon</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 16px;">
          Your <strong style="color:#e8f0fd;">${label}</strong> plan expires in <strong style="color:#f59e0b;">${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong> (on ${expiryDate}).
        </p>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;">
          To continue using ImportMyBooks without interruption, please contact your administrator or renew your plan.
        </p>
        <p style="font-size:12px;color:#4e6082;">After expiry, imports will be blocked until the plan is renewed.</p>
      </div>
    `,
    text: `Your ImportMyBooks ${label} plan expires in ${daysLeft} day(s) on ${expiryDate}. Please renew to avoid interruption.`,
  });
}

export async function sendPlanExpiredEmail(email, planName) {
  const label = planName.charAt(0).toUpperCase() + planName.slice(1);
  return sendMail({
    to: email,
    subject: `ImportMyBooks — Your ${label} plan has expired`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 12px;">❌ Plan expired</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 16px;">
          Your <strong style="color:#e8f0fd;">${label}</strong> plan has expired. Imports are currently blocked.
        </p>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;">
          To restore access, please contact your administrator to renew or upgrade your plan.
        </p>
        <p style="font-size:12px;color:#4e6082;">Your historical import data remains safe and accessible once renewed.</p>
      </div>
    `,
    text: `Your ImportMyBooks ${label} plan has expired. Contact your administrator to renew access.`,
  });
}

export async function sendPlanRenewedEmail(email, planName, days, newExpiry) {
  const label = planName.charAt(0).toUpperCase() + planName.slice(1);
  return sendMail({
    to: email,
    subject: `ImportMyBooks — Your ${label} plan has been renewed`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 12px;">✅ Plan renewed!</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 16px;">
          Your <strong style="color:#e8f0fd;">${label}</strong> plan has been renewed for <strong style="color:#2dd4bf;">${days} more days</strong>.
        </p>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;">
          New expiry date: <strong style="color:#e8f0fd;">${newExpiry}</strong>
        </p>
        <p style="font-size:12px;color:#4e6082;">Thank you for continuing with ImportMyBooks!</p>
      </div>
    `,
    text: `Your ImportMyBooks ${label} plan has been renewed for ${days} more days. New expiry: ${newExpiry}.`,
  });
}

export async function sendPlanCancelledEmail(email, planName) {
  const label = planName.charAt(0).toUpperCase() + planName.slice(1);
  return sendMail({
    to: email,
    subject: `ImportMyBooks — Your ${label} plan has been cancelled`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0c1525;color:#e8f0fd;border-radius:12px;">
        <div style="font-size:22px;font-weight:800;color:#2dd4bf;margin-bottom:8px;">ImportMyBooks</div>
        <div style="font-size:12px;color:#4e6082;margin-bottom:24px;">importmybooks.com</div>
        <h2 style="font-size:18px;margin:0 0 12px;">Plan Cancelled</h2>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 16px;">
          Your <strong style="color:#e8f0fd;">${label}</strong> plan has been cancelled. Import access is now blocked.
        </p>
        <p style="font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;">
          If you believe this is a mistake or wish to reactivate, please contact us.
        </p>
        <p style="font-size:12px;color:#4e6082;">Your data remains safe for 30 days after cancellation.</p>
      </div>
    `,
    text: `Your ImportMyBooks ${label} plan has been cancelled. Contact us to reactivate.`,
  });
}

export { isConfigured as smtpConfigured };
