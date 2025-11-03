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
  TIMEZONE: process.env.TIMEZONE ?? "America/Toronto",
  NODE_ENV: process.env.NODE_ENV ?? "development",
  JWT_SECRET: process.env.JWT_SECRET ?? "dev-secret-change-me",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? "",
  // Autoriser plusieurs origines, séparées par des virgules
  CLIENT_ORIGINS: (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
