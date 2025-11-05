import dotenv from "dotenv";
import path from "path";

// Charge toujours les variables d'env depuis server/.env, même si le process est lancé depuis la racine du monorepo
try {
  const envPath = path.resolve(__dirname, "../.env");
  dotenv.config({ path: envPath });
} catch {
  // Fallback silencieux
  dotenv.config();
}

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  CRON_TICK: process.env.CRON_TICK ?? "0 * * * *",
  MARKET_TICK_CRON: process.env.MARKET_TICK_CRON ?? "0 */12 * * * *", // par défaut: 1 tick boursier toutes les 12 min (~5 j de bourse/heure)
  TIMEZONE: process.env.TIMEZONE ?? "America/Toronto",
  NODE_ENV: process.env.NODE_ENV ?? "development",
  JWT_SECRET: process.env.JWT_SECRET ?? "dev-secret-change-me",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? "",
  ADMIN_VERIFY_SECRET: process.env.ADMIN_VERIFY_SECRET ?? "",
  MIGRATE_ON_BOOT: (process.env.MIGRATE_ON_BOOT ?? "false").toLowerCase() === "true",
  SEED_ON_BOOT: (process.env.SEED_ON_BOOT ?? "false").toLowerCase() === "true",
  // Permettre temporairement la connexion même si l'email n'est pas vérifié (utile en dev/démo si SMTP absent)
  SKIP_EMAIL_VERIFICATION: (process.env.SKIP_EMAIL_VERIFICATION ?? "false").toLowerCase() === "true",
  // Autoriser plusieurs origines, séparées par des virgules
  CLIENT_ORIGINS: (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // SMTP/Reset password
  SMTP_HOST: process.env.SMTP_HOST ?? "",
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
  SMTP_SECURE: (process.env.SMTP_SECURE ?? "false").toLowerCase() === "true",
  SMTP_USER: process.env.SMTP_USER ?? "",
  SMTP_PASS: process.env.SMTP_PASS ?? "",
  MAIL_FROM: process.env.MAIL_FROM ?? "",
  APP_ORIGIN: process.env.APP_ORIGIN ?? (process.env.CLIENT_ORIGIN?.split(",")[0] || "http://localhost:3000"),
};
