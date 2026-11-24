import nodemailer from "nodemailer";

const useSmtp = !!process.env.SMTP_HOST;
let transporter = null;
if (useSmtp) {
  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

export async function sendMail({ to, subject, text, html }) {
  if (process.env.TEST === "true" || !transporter) {
    if (process.env.NODE_ENV === "production" || process.env.DEPLOYMENT === "true") {
      throw new Error("SMTP is required to send email in production");
    }
    console.log(`[MAIL] to=${to} subject="${subject}"`);
    return;
  }
  await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject, text, html });
}