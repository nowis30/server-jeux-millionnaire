import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import { env } from "./env";
import { registerGameRoutes } from "./routes/games";
import { setupSocket } from "./socket";
import cron from "node-cron";
import { hourlyTick, annualUpdate, nightlyRefresh } from "./services/simulation";
import { dailyMarketTick, ensureMarketHistory } from "./services/market";
import { registerPropertyRoutes } from "./routes/properties";
import { registerMarketRoutes } from "./routes/markets";
import { registerListingRoutes } from "./routes/listings";
import { ensureTemplateListings } from "./services/listings";
import { prisma } from "./prisma";
import type { Server as SocketIOServer } from "socket.io";
import { registerHealthRoutes } from "./routes/health";
import { registerAuthRoutes } from "./routes/auth";
import { registerDocs } from "./routes/docs";
import { execSync } from "child_process";

async function bootstrap() {
  // Option: exécuter les migrations Prisma au démarrage si demandé
  if (env.MIGRATE_ON_BOOT) {
    try {
      console.log("[boot] Running prisma migrate deploy...");
      execSync("npx prisma migrate deploy", { stdio: "inherit" });
      console.log("[boot] Prisma migrate deploy done.");
    } catch (e) {
      console.error("[boot] Prisma migrate deploy failed", e);
    }
  }
  if (env.SEED_ON_BOOT) {
    try {
      console.log("[boot] Running seed script prisma/seed.js...");
      execSync("node prisma/seed.js", { stdio: "inherit" });
      console.log("[boot] Seed done.");
    } catch (e) {
      console.error("[boot] Seed failed", e);
    }
  }
  const app = Fastify({ logger: true });
  // CORS: accepter une liste d'origines
  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      // autoriser requêtes serveur-à-serveur et outils (origin nul)
      if (!origin) return cb(null, true);
  if (env.CLIENT_ORIGINS.includes(origin)) return cb(null, true);
  // autoriser tous les déploiements Vercel en preview
  if (/\.vercel\.app$/.test(origin)) return cb(null, true);
      // autoriser localhost en dev
      if (origin.startsWith("http://localhost:")) return cb(null, true);
      cb(new Error("Origin not allowed"), false);
    },
  });
  // Helmet désactivé temporairement (incompatibilité de version avec Fastify v4). À réactiver après MAJ des versions.
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(cookie);

  app.decorate("prisma", prisma);

  // Auth invité par cookie: attribuer un UUID si absent
  app.addHook("onRequest", async (request, reply) => {
    const COOKIE_NAME = "hm_guest";
    const existing = (request as any).cookies?.[COOKIE_NAME];
    if (!existing) {
      // Utilise nanoid pour générer un identifiant stable côté client
      const { nanoid } = await import("nanoid");
      const id = nanoid();
      reply.setCookie(COOKIE_NAME, id, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365, // 1 an
      });
    }
  });

  // Gestionnaire d'erreurs standardisé (Zod -> 400)
  app.setErrorHandler((err, req, reply) => {
    const isZod = (err as any)?.issues && (err as any)?.name === 'ZodError';
    if (isZod) {
      return reply.status(400).send({ error: 'Validation error', details: (err as any).issues });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: 'Internal Server Error' });
  });

  // Routes REST
  await registerGameRoutes(app);
  await registerPropertyRoutes(app);
  await registerMarketRoutes(app);
  await registerListingRoutes(app);
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  try {
    await registerDocs(app);
  } catch (e) {
    app.log.warn({ err: e }, "Swagger non chargé — démarrage sans /docs");
  }

  // Socket.IO attaché au server HTTP
  const { io, emitLeaderboard } = setupSocket(app.server);
  app.decorate("io", io as SocketIOServer);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
    io.close();
  });

  const hourlyCron = cron.validate(env.CRON_TICK) ? env.CRON_TICK : "0 * * * *";
  if (hourlyCron !== env.CRON_TICK) {
    app.log.warn({ provided: env.CRON_TICK }, "Expression CRON invalide, utilisation du fallback '0 * * * *'");
  }

  // Cron horaire
  cron.schedule(hourlyCron, async () => {
    app.log.info("[cron] hourlyTick");
    // pour chaque partie en cours
    const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
    for (const g of games) {
      await hourlyTick(g.id);
      // émettre classement rudimentaire
      const players = await prisma.player.findMany({
        where: { gameId: g.id },
        orderBy: { netWorth: "desc" },
        select: { id: true, nickname: true, netWorth: true },
      });
      emitLeaderboard(
        g.id,
        players.map((p: { id: string; nickname: string; netWorth: number }) => ({
          playerId: p.id,
          nickname: p.nickname,
          netWorth: p.netWorth,
        }))
      );

      // Mode sans fin: pas de condition de fin, la partie continue indéfiniment.
    }
  }, { timezone: env.TIMEZONE });

  // Cron marché: 7 ticks par heure (~toutes les 8-9 minutes)
  const sevenPerHour = "0,8,17,25,34,42,51 * * * *";
  cron.schedule(sevenPerHour, async () => {
    app.log.info("[cron] market daily tick (x7/h)");
    const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
    for (const g of games) {
      await ensureMarketHistory(g.id, 50);
      await dailyMarketTick(g.id);
      // rotation d'annonces immobilières issues de la banque
      await ensureTemplateListings(g.id, 12, 2);
    }
  }, { timezone: env.TIMEZONE });

  // Cron annuel (toutes les 52 heures réelles) — approximé ici: toutes les 52 exécutions
  let hourCounter = 0;
  cron.schedule(hourlyCron, async () => {
    hourCounter++;
    if (hourCounter % 52 === 0) {
      app.log.info("[cron] annualUpdate");
      const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
      for (const g of games) await annualUpdate(g.id);
    }
  }, { timezone: env.TIMEZONE });

  // Rafraîchissement nocturne (03:00 timezone locale)
  cron.schedule("0 3 * * *", async () => {
    app.log.info("[cron] nightlyRefresh");
    const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
    for (const g of games) await nightlyRefresh(g.id);
  }, { timezone: env.TIMEZONE });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

// Type augmentation pour Fastify instance
declare module "fastify" {
  interface FastifyInstance {
    prisma: import("@prisma/client").PrismaClient;
  }
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
