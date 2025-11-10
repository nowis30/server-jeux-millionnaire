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
import { cleanupMarketTicks } from "./services/tickCleanup";
import { registerQuizRoutes } from "./routes/quiz";
import { registerPariRoutes } from "./routes/pari";
import { registerTokenRoutes } from "./routes/tokens";
import { registerReferralRoutes } from "./routes/referrals";
import { registerBonusRoutes } from "./routes/bonus";
import { generateAndSaveQuestions, replenishIfLow, maintainQuestionStock, ensureKidsPool, ensureMediumPool } from "./services/aiQuestions";
import { ensurePropertyTypeQuotas } from "./services/seeder";

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
      // autoriser localhost en dev (http et https, avec/sans port)
      if (origin.startsWith("http://localhost:")) return cb(null, true);
      if (origin.startsWith("https://localhost:")) return cb(null, true);
      if (origin === "http://localhost" || origin === "https://localhost") return cb(null, true);
      // autoriser Capacitor (app mobile)
      if (origin === "capacitor://localhost") return cb(null, true);
      // Log refus pour diagnostic en production (CORS)
      app.log.warn({ origin }, "CORS origin refusé");
      cb(new Error("Origin not allowed"), false);
    },
  });
  app.log.info({ origins: env.CLIENT_ORIGINS }, "CORS: origines autorisées chargées");
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
      
      // Exemptions: auth endpoints et quiz (qui utilisent X-Player-ID pour sécurité)
      if (url.startsWith("/api/auth/login") || 
          url.startsWith("/api/auth/register") || 
          url.startsWith("/api/auth/logout") ||
          url.includes("/quiz/")) {
        return;
      }
      
      const csrfCookie = (req as any).cookies?.["hm_csrf"];
      const tokenHeader = (req.headers?.["x-csrf-token"] as string) || (req.headers?.["x-xsrf-token"] as string);
      
      // Si le token correspond au cookie -> OK
      if (csrfCookie && tokenHeader && tokenHeader === csrfCookie) return;
      
      // Tolérance: si l'origine est autorisée et qu'une session utilisateur est présente (hm_auth),
      // on autorise sans CSRF pour compatibilité avec les navigateurs bloquant les cookies tiers.
      const origin = (req.headers?.["origin"] as string) || "";
      const allowed =
        !origin ||
        env.CLIENT_ORIGINS.includes(origin) ||
        /\.vercel\.app$/.test(origin) ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("https://localhost:") ||
        origin === "http://localhost" ||
        origin === "https://localhost" ||
        origin === "capacitor://localhost";
      const hasAuth = Boolean((req as any).cookies?.["hm_auth"]);
      const hasGuest = Boolean((req as any).cookies?.["hm_guest"]);
      const hasPlayerId = Boolean(req.headers?.["x-player-id"]);
      
      // Tolérer si origine autorisée ET (header CSRF présent OU session authentifiée OU guest/playerId présent)
      if (allowed && tokenHeader) return;
      if (allowed && hasAuth) return;
      if (allowed && (hasGuest || hasPlayerId)) return;
      
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
  await registerQuizRoutes(app);
  await registerPariRoutes(app);
  await registerTokenRoutes(app);
  await registerReferralRoutes(app);
  await registerBonusRoutes(app);
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

  // Vérification immédiate au démarrage: assurer une banque suffisante et des 6‑plex présents
  try {
    const quotas = await ensurePropertyTypeQuotas(5);
    app.log.info({ quotas }, "[boot] Quotas immo assurés (min 5 par type)");
    const count = await prisma.propertyTemplate.count();
    if (count < 50) {
      const { seedAll } = await import("./services/seeder");
      app.log.info({ count }, "[boot] Banque immo < 50 → top-up global");
      const res = await seedAll(50);
      app.log.info({ result: res }, "[boot] Banque immo remontée à 50");
    }
  } catch (e) {
    app.log.warn({ err: e }, "[boot] Vérification/reseed banque immo a échoué");
  }

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

    // Maintien de stock: produire si <800, viser 1000
    try {
      const { remaining, created, target } = await maintainQuestionStock(800, 1000);
      if (created > 0) {
        app.log.info({ remainingBefore: remaining, created, target }, "[cron] Quiz: maintien de stock vers 1000");
      }
    } catch (e: any) {
      app.log.warn({ err: e?.message || e }, "[cron] maintainQuestionStock a échoué");
    }

    // Maintien de la banque d'immeubles: quotas par type (min 5) + minimum total 50
    try {
      const { ensurePropertyTypeQuotas, seedAll } = await import("./services/seeder");
      const quotas = await ensurePropertyTypeQuotas(5);
      app.log.info({ quotas }, "[cron] Quotas immo assurés (min 5 par type)");
      const count = await prisma.propertyTemplate.count();
      if (count < 50) {
        app.log.info({ count }, "[cron] Banque immo < 50 → top-up global");
        const res = await seedAll(50);
        app.log.info({ result: res }, "[cron] Banque immo remontée à 50");
      }
    } catch (e) {
      app.log.warn({ err: e }, "[cron] Vérification/reseed banque immo a échoué");
    }
  }, { timezone: env.TIMEZONE });

  // Cron toutes les 5 minutes: quotas par type (incl. 6‑plex) + minimum total 50
  cron.schedule("*/5 * * * *", async () => {
    app.log.info("[cron] immo (5 min): vérifier quotas et banque");
    try {
      const quotas = await ensurePropertyTypeQuotas(5);
      app.log.info({ quotas }, "[cron] immo (5 min): quotas assurés (min 5 par type)");
      const count = await prisma.propertyTemplate.count();
      if (count < 50) {
        const { seedAll } = await import("./services/seeder");
        app.log.info({ count }, "[cron] immo (5 min): banque < 50 → top-up global");
        const res = await seedAll(50);
        app.log.info({ result: res }, "[cron] immo (5 min): banque remontée à 50");
      }
    } catch (err) {
      app.log.error({ err }, "[cron] immo (5 min): échec quotas/top-up");
    }
  }, { timezone: env.TIMEZONE });

  // Cron marché: cadencé par MARKET_TICK_CRON (par défaut: toutes les 12 minutes)
  // Objectif: ~5 jours de bourse par heure réelle (1 tick = 1 jour ouvré) => cohérent avec 1 semaine de jeu = 1h.
  const marketCron = env.MARKET_TICK_CRON;
  cron.schedule(marketCron, async () => {
    app.log.info("[cron] market daily tick (every 10s)");
    const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
    for (const g of games) {
      await ensureMarketHistory(g.id, 10);
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

  // Quiz enfants: top-up nocturne dédié (03:10) pour garantir un stock de 500 faciles sans doublons
  cron.schedule("10 3 * * *", async () => {
    try {
      const res = await ensureKidsPool(480, 500);
      if (res.created > 0) {
        app.log.info({ remainingBefore: res.remaining, created: res.created, target: res.target }, "[cron] Kids: pool complété vers 500");
      } else {
        app.log.info({ remaining: res.remaining }, "[cron] Kids: pool OK (≥480)");
      }
    } catch (err: any) {
      app.log.warn({ err: err?.message || err }, "[cron] Kids ensureKidsPool a échoué");
    }
  }, { timezone: env.TIMEZONE });

  // Quiz medium ciblé (definitions, quebec): top-up nocturne (03:20) vers 500
  cron.schedule("20 3 * * *", async () => {
    try {
      const res = await ensureMediumPool(480, 500);
      if (res.created > 0) {
        app.log.info({ remainingBefore: res.remaining, created: res.created, target: res.target }, "[cron] Medium ciblé: pool complété vers 500");
      } else {
        app.log.info({ remaining: res.remaining }, "[cron] Medium ciblé: pool OK (≥480)");
      }
    } catch (err: any) {
      app.log.warn({ err: err?.message || err }, "[cron] ensureMediumPool a échoué");
    }
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
      const holdings = await prisma.propertyHolding.findMany({ where: { gameId: g.id }, select: { id: true, mortgageDebt: true, termYears: true } as any }) as any[];
      for (const h of holdings) {
        const years = h?.termYears ? Math.min(25, Math.max(5, Number(h.termYears))) : 25;
        const principal: number = Number(h.mortgageDebt ?? 0) || 0;
        const weekly = computeWeeklyMortgage(principal, next, years);
        await prisma.propertyHolding.update({ where: { id: String(h.id) }, data: { mortgageRate: next, weeklyPayment: weekly } });
      }
    }
  }, { timezone: env.TIMEZONE });

  // Prix Amazon 20$ — 31/12/2025: tenter l'attribution à 23:00 le 31 décembre
  cron.schedule("0 0 23 31 12 *", async () => {
    try {
      const { checkAndAwardAmazon2025 } = await import("./services/prizes");
      if (new Date().getFullYear() === 2025) await checkAndAwardAmazon2025();
    } catch (err) {
      app.log.error({ err }, "[cron] prize amazon 2025");
    }
  }, { timezone: env.TIMEZONE });

  // Filet de sécurité: si le serveur était down, réessayer le 1er janvier suivant à midi
  cron.schedule("0 0 12 1 1 *", async () => {
    try {
      const { checkAndAwardAmazon2025 } = await import("./services/prizes");
      await checkAndAwardAmazon2025();
    } catch (err) {
      app.log.error({ err }, "[cron] prize amazon 2025 (rattrapage)");
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

  // Nettoyage automatique des ticks de marché toutes les 20 minutes
  // Garde les 100 derniers ticks + 1 sur 100 des anciens pour chaque symbole
  cron.schedule("*/20 * * * *", async () => {
    app.log.info("[cron] cleanup market ticks (every 20 min)");
    const games = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
    for (const g of games) {
      try {
        const deleted = await cleanupMarketTicks(g.id);
        if (deleted > 0) {
          app.log.info({ gameId: g.id, deleted }, "Ticks nettoyés automatiquement");
        }
      } catch (err) {
        app.log.error({ gameId: g.id, err }, "Erreur nettoyage automatique ticks");
      }
    }
  }, { timezone: env.TIMEZONE });

  // Génération IA: ne produire que si le stock est bas (<800), viser 1000
  cron.schedule("0 * * * *", async () => {
    app.log.info("[cron] AI maintain stock (every hour)");
    try {
      const { remaining, created, target } = await maintainQuestionStock(800, 1000);
      if (created > 0) {
        app.log.info({ remainingBefore: remaining, created, target }, "[cron] AI: stock réapprovisionné vers 1000");
      }
    } catch (err) {
      app.log.error({ err }, "Erreur maintien du stock IA");
    }
  }, { timezone: env.TIMEZONE });

  // Vérification/rappel toutes les 5 minutes: s'assurer qu'il y a bien 1000 questions "restantes"
  // et demander à l'IA de remplir la base si nécessaire (pas de doublons, 3 niveaux de difficulté).
  cron.schedule("*/5 * * * *", async () => {
    try {
      const { remaining, created, target } = await maintainQuestionStock(1000, 1000);
      if (created > 0) {
        app.log.info({ remainingBefore: remaining, created, target }, "[cron] AI (5 min): stock complété jusqu'à 1000");
      } else {
        app.log.info({ remaining }, "[cron] AI (5 min): stock OK (≥1000)");
      }
    } catch (err) {
      app.log.error({ err }, "[cron] AI (5 min): échec vérification/complément stock");
    }
  }, { timezone: env.TIMEZONE });

  // Distribution automatique de tokens quiz toutes les minutes
  // Vérifie et distribue les tokens gagnés automatiquement aux joueurs actifs
  cron.schedule("* * * * *", async () => {
    try {
      const { distributeTokensToActivePlayers } = await import("./services/quizTokens");
      await distributeTokensToActivePlayers();
    } catch (err) {
      app.log.error({ err }, "Erreur distribution tokens quiz");
    }
  }, { timezone: env.TIMEZONE });

  // Écoute HTTP d'abord pour que Render détecte le port rapidement
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info({ port: env.PORT }, "HTTP server listening");

  // Pré-chauffer l'historique marché (10 ans) en tâche de fond (ne pas bloquer le port binding Render)
  (async () => {
    try {
      const running = await prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
      for (const g of running) {
        await ensureMarketHistory(g.id, 10).catch((e) => app.log.warn({ err: e }, "ensureMarketHistory background failed"));
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
