import { env } from "../env";

type MailOptions = {
  to: string;
  subject: string;
  html: string;
};

export async function sendMail(opts: MailOptions) {
  const { to, subject, html } = opts;
  // Si pas de config SMTP, fallback console
  if (!env.SMTP_HOST || !env.MAIL_FROM) {
    console.log(`[mailer:fallback] To=${to} Subject=${subject} Html=${html}`);
    return { ok: true, transport: "console" } as const;
  }
  // Chargement dynamique de nodemailer pour éviter d’alourdir en dev sans SMTP
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer: any = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  await transporter.sendMail({ from: env.MAIL_FROM, to, subject, html });
  return { ok: true, transport: "smtp" } as const;
}
