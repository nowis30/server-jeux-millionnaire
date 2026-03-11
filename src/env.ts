import dotenv from "dotenv";
import path from "path";

type CookieSameSite = "strict" | "lax" | "none";

export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

// Charge toujours les variables d'env depuis server/.env, même si le process est lancé depuis la racine du monorepo
try {
  const envPath = path.resolve(__dirname, "../.env");
  dotenv.config({ path: envPath });
} catch {
  // Fallback silencieux
  dotenv.config();
}

const clientOrigins = Array.from(new Set([
  ...(
    process.env.CLIENT_ORIGIN ??
    process.env.CORS_ORIGIN ??
    [process.env.FRONTEND_URL, process.env.APP_URL, process.env.APP_ORIGIN].filter(Boolean).join(",") ??
    "http://localhost:3000"
  )
    .split(",")
    .map((s) => normalizeOrigin(s))
    .filter(Boolean),
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://nowis.store",
  "https://app.nowis.store",
].map((s) => normalizeOrigin(s))));

const cookieSameSite: CookieSameSite =
  process.env.COOKIE_SAME_SITE === "strict" || process.env.COOKIE_SAME_SITE === "lax" || process.env.COOKIE_SAME_SITE === "none"
    ? process.env.COOKIE_SAME_SITE
    : (process.env.NODE_ENV === "production" ? "none" : "lax");

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  CRON_TICK: process.env.CRON_TICK ?? "0 * * * *",
  MARKET_TICK_CRON: process.env.MARKET_TICK_CRON ?? "0 */12 * * * *", // par défaut: 1 tick boursier toutes les 12 min (~5 j de bourse/heure)
  TIMEZONE: process.env.TIMEZONE ?? "America/Toronto",
  NODE_ENV: process.env.NODE_ENV ?? "development",
  LOG_LEVEL: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  JWT_SECRET: process.env.JWT_SECRET ?? "dev-secret-change-me",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? "",
  ADMIN_VERIFY_SECRET: process.env.ADMIN_VERIFY_SECRET ?? "",
  MIGRATE_ON_BOOT: (process.env.MIGRATE_ON_BOOT ?? "false").toLowerCase() === "true",
  SEED_ON_BOOT: (process.env.SEED_ON_BOOT ?? "false").toLowerCase() === "true",
  // Permettre temporairement la connexion même si l'email n'est pas vérifié (utile en dev/démo si SMTP absent)
  SKIP_EMAIL_VERIFICATION: (process.env.SKIP_EMAIL_VERIFICATION ?? "false").toLowerCase() === "true",
  // Autoriser plusieurs origines, séparées par des virgules
  CLIENT_ORIGINS: clientOrigins,
  // SMTP/Reset password
  SMTP_HOST: process.env.SMTP_HOST ?? "",
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
  SMTP_SECURE: (process.env.SMTP_SECURE ?? "false").toLowerCase() === "true",
  SMTP_USER: process.env.SMTP_USER ?? "",
  SMTP_PASS: process.env.SMTP_PASS ?? "",
  MAIL_FROM: process.env.MAIL_FROM ?? "",
  APP_ORIGIN: normalizeOrigin(process.env.APP_ORIGIN ?? process.env.APP_URL ?? "http://localhost:3000"),
  SITE_ORIGIN: normalizeOrigin(process.env.SITE_ORIGIN ?? process.env.FRONTEND_URL ?? "https://nowis.store"),
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN?.trim() || "",
  COOKIE_SECURE: (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === "production" ? "true" : "false")).toLowerCase() === "true",
  ALLOW_VERCEL_PREVIEWS: (process.env.ALLOW_VERCEL_PREVIEWS ?? "false").toLowerCase() === "true",
  COOKIE_SAME_SITE: cookieSameSite,
};

export function isAllowedOrigin(origin?: string | null): boolean {
  if (!origin || origin === "null") return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return true;
  if (env.CLIENT_ORIGINS.includes(normalized)) return true;
  if (env.ALLOW_VERCEL_PREVIEWS && /\.vercel\.app$/i.test(normalized)) return true;
  if (normalized === "https://nowis30.github.io" || normalized.endsWith(".github.io")) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) return true;
  if (normalized === "capacitor://localhost") return true;
  return false;
}
