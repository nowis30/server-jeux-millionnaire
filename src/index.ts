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
import { prisma } from "./prisma";
import type { Server as SocketIOServer } from "socket.io";
import { registerHealthRoutes } from "./routes/health";
import { registerAuthRoutes } from "./routes/auth";
import { registerDocs } from "./routes/docs";
import { execSync } from "child_process";
import path from "path";
import { prisma as prismaClient } from "./prisma";
import { computeWeeklyMortgage } from "./services/simulation";
import { registerEconomyRoutes } from "./routes/economy";

async function bootstrap() {
  // Exécuter les migrations Prisma au démarrage (idempotent). Utile sur Render sans shell.
  try {
    console.log("[boot] Running prisma migrate deploy...");
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
    });
    console.log("[boot] Prisma migrate deploy done.");
  } catch (e) {
    console.error("[boot] Prisma migrate deploy failed", e);
  }
  // Vérification schéma: si certaines tables n'existent pas (ex: MarketTick) et pas de shell Render,
  // pousser le schéma automatiquement en fallback.
  try {
    await prisma.marketTick.count();
  } catch (e) {
    try {
      console.warn("[boot] Prisma schema incomplete — running 'prisma db push' fallback...");
      execSync("npx prisma db push", {
        stdio: "inherit",
        cwd: path.resolve(__dirname, ".."),
      });
      console.log("[boot] Prisma db push completed.");
    } catch (e2) {
      console.error("[boot] Prisma db push failed", e2);
    }
  }
  if (env.SEED_ON_BOOT) {
    try {
      console.log("[boot] Running seed script prisma/seed.js...");
      execSync("node prisma/seed.js", {
        stdio: "inherit",
        cwd: path.resolve(__dirname, ".."),
      });
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
        sameSite: "none",
        secure: true,
        maxAge: 60 * 60 * 24 * 365, // 1 an
      });
    }

    // CSRF: assurer un token non-HttpOnly disponible côté client pour les requêtes d'écriture
    const CSRF_COOKIE = "hm_csrf";
    const csrfExisting = (request as any).cookies?.[CSRF_COOKIE];
    if (!csrfExisting) {
      const { nanoid } = await import("nanoid");
      const token = nanoid();
      // Non httpOnly pour lecture par le client
      reply.setCookie(CSRF_COOKIE, token, {
        path: "/",
        httpOnly: false,
        sameSite: "none",
        secure: true,
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

  // Vérification CSRF pour méthodes non sûres
  app.addHook("preHandler", async (req, reply) => {
    const method = (req.method || "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const url = (req as any).url as string;
      // Exemptions: auth endpoints
      if (url.startsWith("/api/auth/login") || url.startsWith("/api/auth/register") || url.startsWith("/api/auth/logout")) {
        return;
      }
  const csrfCookie = (req as any).cookies?.["hm_csrf"];
  const tokenHeader = (req.headers?.["x-csrf-token"] as string) || (req.headers?.["x-xsrf-token"] as string);
  // Si le token correspond au cookie -> OK
  if (csrfCookie && tokenHeader && tokenHeader === csrfCookie) return;
      // Tolérance: si l'origine est autorisée et qu'une session utilisateur est présente (hm_auth),
      // on autorise sans CSRF pour compatibilité avec les navigateurs bloquant les cookies tiers.
      const origin = (req.headers?.["origin"] as string) || "";
      const allowed = !origin || env.CLIENT_ORIGINS.includes(origin) || /\.vercel\.app$/.test(origin) || origin.startsWith("http://localhost:");
      const hasAuth = Boolean((req as any).cookies?.["hm_auth"]);
      // Tolérer si origine autorisée ET header CSRF présent (même si le cookie CSRF est bloqué par le navigateur)
      if (allowed && tokenHeader) return;
      if (allowed && hasAuth) return;
      return reply.status(403).send({ error: "CSRF token invalid" });
    }
  });

  // Routes REST
  await registerGameRoutes(app);
  await registerPropertyRoutes(app);
  await registerMarketRoutes(app);
  await registerListingRoutes(app);
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerEconomyRoutes(app);
  try {
    await registerDocs(app);
  } catch (e) {
    app.log.warn({ err: e }, "Swagger non chargé — démarrage sans /docs");
  }

  // Nettoyage au démarrage: supprimer les annonces NPC (templates sans vendeur)
  try {
    const del = await prisma.listing.deleteMany({ where: { sellerId: null, templateId: { not: null } } });
    if (del.count > 0) app.log.info({ count: del.count }, "Suppression des annonces NPC au démarrage");
  } catch (e) {
    app.log.warn({ err: e }, "Échec du nettoyage des annonces NPC au démarrage");
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

  // Cron marché: ~70 ticks par heure (toutes les ~51 secondes)
  // Remarque: node-cron accepte les secondes (6 champs). 3600/51 ≈ 70,6 ticks/heure.
  const seventyPerHour = "*/51 * * * * *";
  cron.schedule(seventyPerHour, async () => {
    app.log.info("[cron] market daily tick (~70/h)");
    const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
    for (const g of games) {
      await ensureMarketHistory(g.id, 50);
      await dailyMarketTick(g.id);
      // (désactivé) rotation d'annonces immobilières issues de la banque — on ne conserve que les annonces des joueurs
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

  // Taux hypothécaires variables: le 1er de chaque mois, ajuster de +/-0.25% dans [2%,7%]
  cron.schedule("0 1 0 1 * *", async () => {
    app.log.info("[cron] monthly rate step +/-0.25% et MAJ paiements hypothécaires");
    const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
    for (const g of games) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const step = 0.0025 * dir; // 0.25%
      const prev = (g as any).baseMortgageRate ?? 0.05;
      const next = Math.max(0.02, Math.min(0.07, prev + step));
      await (prisma as any).game.update({ where: { id: g.id }, data: { baseMortgageRate: next } });
      // Appliquer le taux aux holdings (variable) et recalculer le paiement hebdo sur 25 ans basé sur la dette restante
      const holdings = await prisma.propertyHolding.findMany({ where: { gameId: g.id }, select: { id: true, mortgageDebt: true } });
      for (const h of holdings) {
        const weekly = computeWeeklyMortgage(h.mortgageDebt, next);
        await prisma.propertyHolding.update({ where: { id: h.id }, data: { mortgageRate: next, weeklyPayment: weekly } });
      }
    }
  }, { timezone: env.TIMEZONE });

  // Chaque 1er janvier, choisir l'appréciation annuelle dans [2%,5%] pour l'année
  cron.schedule("0 5 0 1 1 *", async () => {
    app.log.info("[cron] yearly appreciation pick [2%,5%]");
    const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
    for (const g of games) {
      const appr = 0.02 + Math.random() * 0.03; // 2% à 5%
      await (prisma as any).game.update({ where: { id: g.id }, data: { appreciationAnnual: appr } });
    }
  }, { timezone: env.TIMEZONE });

  // Écoute HTTP d'abord pour que Render détecte le port rapidement
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info({ port: env.PORT }, "HTTP server listening");

  // Pré-chauffer l'historique marché en tâche de fond (ne pas bloquer le port binding Render)
  (async () => {
    try {
      const running = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
      for (const g of running) {
        await ensureMarketHistory(g.id, 50).catch((e) => app.log.warn({ err: e }, "ensureMarketHistory background failed"));
      }
    } catch (e) {
      app.log.warn({ err: e }, "prewarm ensureMarketHistory skipped");
    }
  })();
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

// Assure l'existence d'une partie unique globale au démarrage
(async () => {
  try {
    const GLOBAL_CODE = process.env.GLOBAL_GAME_CODE || "GLOBAL";
    let g = await prismaClient.game.findUnique({ where: { code: GLOBAL_CODE } });
    if (!g) {
      g = await prismaClient.game.create({ data: { code: GLOBAL_CODE, status: "running", startedAt: new Date() } });
      console.log(`[boot] Created global game ${g.code} (${g.id})`);
    } else if (g.status !== "running") {
      await prismaClient.game.update({ where: { id: g.id }, data: { status: "running", startedAt: g.startedAt ?? new Date() } });
      console.log(`[boot] Ensured global game running (${g.code})`);
    }
  } catch (e) {
    console.warn("[boot] ensure global game failed (will retry via API usage)", e);
  }
})();
