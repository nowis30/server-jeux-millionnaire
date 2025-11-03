"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Charge toujours les variables d'env depuis server/.env, même si le process est lancé depuis la racine du monorepo
try {
    const envPath = path_1.default.resolve(__dirname, "../.env");
    dotenv_1.default.config({ path: envPath });
}
catch {
    // Fallback silencieux
    dotenv_1.default.config();
}
exports.env = {
    PORT: Number(process.env.PORT ?? 3001),
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    CRON_TICK: process.env.CRON_TICK ?? "0 * * * *",
    TIMEZONE: process.env.TIMEZONE ?? "America/Toronto",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    // Autoriser plusieurs origines, séparées par des virgules
    CLIENT_ORIGINS: (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
};
