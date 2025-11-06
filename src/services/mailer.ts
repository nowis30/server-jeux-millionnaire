import { env } from "../env";
// Mailer unifié: fallback console si SMTP non configuré.
export type MailOptions = { to: string; subject: string; html: string; text?: string };

export async function sendMail(opts: MailOptions) {
  const { to, subject, html, text } = opts;
  if (!env.SMTP_HOST || !env.MAIL_FROM) {
    console.log(`[mailer:fallback] To=${to} Subject=${subject}`);
    return { ok: true, transport: "console" } as const;
  }
  // Chargement dynamique (évite import si non utilisé)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer: any = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  await transporter.sendMail({ from: env.MAIL_FROM, to, subject, html, text });
  return { ok: true, transport: "smtp" } as const;
}
