import { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { z } from "zod";
import { INITIAL_CASH } from "../shared/constants";
import { customAlphabet } from "nanoid";
import { requireAdmin, requireUser } from "./auth";
import { cleanupMarketTicks } from "../services/tickCleanup";
import { getOnlineCount, getOnlineUsers } from "../socket";
import { hourlyTick } from "../services/simulation";

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeGenerator = customAlphabet(codeAlphabet, 6);

export async function registerGameRoutes(app: FastifyInstance) {
  app.get("/api/games", async (_req, reply) => {
    const GLOBAL_CODE = process.env.GLOBAL_GAME_CODE || "GLOBAL";
    // Retourner uniquement la partie globale (créer si manquante)
    let g = await prisma.game.findUnique({ where: { code: GLOBAL_CODE }, include: { players: true } });
    if (!g) {
      const infl = 0.01 + Math.random() * 0.04; // 1%..5%
      // Prisma client pas encore régénéré avec les champs inflation -> cast any
      g = await (prisma as any).game.create({ data: { code: GLOBAL_CODE, status: "running", startedAt: new Date(), inflationAnnual: infl, inflationIndex: 1 }, include: { players: true } });
    }
    const payload = g ? [{
      id: (g as any).id,
      code: (g as any).code,
      status: (g as any).status,
      players: (g as any).players.length,
      createdAt: (g as any).createdAt,
    }] : [];
    return reply.send({ games: payload });
  });

  // Nombre de joueurs connectés (Socket.IO) pour une partie
  app.get("/api/games/:id/online", async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    const online = getOnlineCount(id);
    const users = getOnlineUsers(id);
    return reply.send({ gameId: id, online, users });
  });

  // Créer une partie (option: créer aussi l'hôte pour le cookie invité courant)
  app.post("/api/games", async (req, reply) => {
    const bodySchema = z.object({ hostNickname: z.string().min(2).optional() });
    const { hostNickname } = bodySchema.parse((req as any).body ?? {});
    const GLOBAL_CODE = process.env.GLOBAL_GAME_CODE || "GLOBAL";
    let game: any = await prisma.game.findUnique({ where: { code: GLOBAL_CODE } });
    if (!game) {
      const infl = 0.01 + Math.random() * 0.04; // 1%..5%
      game = await (prisma as any).game.create({ data: { code: GLOBAL_CODE, status: "running", startedAt: new Date(), inflationAnnual: infl, inflationIndex: 1 } });
    } else if (game.status !== "running") {
      game = await prisma.game.update({ where: { id: game.id }, data: { status: "running", startedAt: game.startedAt ?? new Date() } });
    }

    // Optionnel: créer l'hôte lié au cookie invité
    let guestId = (req as any).cookies?.["hm_guest"] as string | undefined;
    let hostPlayer: { id: string } | undefined;
    if (hostNickname) {
      if (!guestId) {
        const { nanoid } = await import("nanoid");
        guestId = nanoid();
  (reply as any).setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "none", secure: true, maxAge: 60 * 60 * 24 * 365 });
      }
      // vérifier unicité du pseudo
      const trimmed = hostNickname.trim();
  const dup = await prisma.player.findFirst({ where: { gameId: game.id, nickname: { equals: trimmed, mode: 'insensitive' } }, select: { id: true } });
      if (dup) return reply.status(409).send({ error: "Pseudo déjà utilisé dans cette partie" });
      hostPlayer = await prisma.player.upsert({
        where: { gameId_guestId: { gameId: game.id, guestId } },
        update: { nickname: trimmed },
        create: { nickname: trimmed, cash: INITIAL_CASH, netWorth: INITIAL_CASH, gameId: game.id, guestId, quizTokens: 15 },
        select: { id: true },
      });
    }

    (app as any).io?.emit("lobby-update", { type: "created", gameId: game.id, code: game.code });
    return reply.send({ id: game.id, code: game.code, status: game.status, playerId: hostPlayer?.id });
  });

  // Rejoindre une partie (par id) en liant le joueur au cookie invité
  app.post("/api/games/:id/join", { preHandler: requireUser(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const bodySchema = z.object({ nickname: z.string().min(2).optional() });
    const { id } = paramsSchema.parse((req as any).params);
    bodySchema.parse((req as any).body ?? {});

    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) return reply.status(404).send({ error: "Game not found" });
    // Partie unique: autoriser le join même si la partie est en cours

    // Pseudo = email obligatoire (lié à l'utilisateur connecté)
    const userEmail = (req as any).user?.email as string;
    const trimmed = String(userEmail || "").trim();
    
    // IMPORTANT: Sur iOS/Safari, les cookies tiers ne fonctionnent pas
    // On cherche TOUJOURS d'abord par nickname (email) pour voir si le joueur existe
    const existingByNickname = await prisma.player.findFirst({ 
      where: { gameId: id, nickname: { equals: trimmed, mode: 'insensitive' } }, 
      select: { id: true, guestId: true } 
    });
    
    let playerId: string;
    let guestId: string;
    
    if (existingByNickname) {
      // Joueur existant trouvé par email
      playerId = existingByNickname.id;
      guestId = existingByNickname.guestId;
      
      // Mettre à jour le cookie (tentatif, peut échouer sur iOS)
      if (guestId) {
        (reply as any).setCookie?.("hm_guest", guestId, { 
          path: "/", 
          httpOnly: true, 
          sameSite: "none", 
          secure: true, 
          maxAge: 60 * 60 * 24 * 365 
        });
      }
    } else {
      // Nouveau joueur : essayer de lire le cookie, sinon en créer un
      const cookieGuestId = (req as any).cookies?.["hm_guest"] as string | undefined;
      
      if (cookieGuestId) {
        guestId = cookieGuestId;
      } else {
        const { nanoid } = await import("nanoid");
        guestId = nanoid();
        (reply as any).setCookie?.("hm_guest", guestId, { 
          path: "/", 
          httpOnly: true, 
          sameSite: "none", 
          secure: true, 
          maxAge: 60 * 60 * 24 * 365 
        });
      }
      
      // Créer le nouveau joueur
      const created = await prisma.player.upsert({
        where: { gameId_guestId: { gameId: id, guestId } },
        update: { nickname: trimmed },
        create: { nickname: trimmed, cash: INITIAL_CASH, netWorth: INITIAL_CASH, gameId: id, guestId, quizTokens: 15 },
        select: { id: true },
      });
      playerId = created.id;
    }
    
    (app as any).io?.emit("lobby-update", { type: "joined", gameId: id });
    return reply.send({ playerId, gameId: id, code: game.code });
  });

  // Réinitialisation douce: remet le cash/netWorth des joueurs, efface l'historique (listings, ticks, logs) mais conserve les joueurs et le game
  app.post("/api/games/:id/reset-soft", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    try {
      const steps: string[] = [];
      // Effacer éléments historiques
      const r1 = await prisma.listing.deleteMany({ where: { gameId: id } }); steps.push(`listings: ${r1.count}`);
      const r2 = await prisma.dividendLog.deleteMany({ where: { gameId: id } }); steps.push(`dividendLogs: ${r2.count}`);
      const r3 = await prisma.marketTick.deleteMany({ where: { gameId: id } }); steps.push(`marketTicks: ${r3.count}`);
      const r4 = await prisma.repairEvent.deleteMany({ where: { holding: { gameId: id } } }); steps.push(`repairEvents: ${r4.count}`);
      const r5 = await prisma.refinanceLog.deleteMany({ where: { holding: { gameId: id } } }); steps.push(`refinanceLogs: ${r5.count}`);
      // Supprimer holdings immobiliers et marchés
      const r6 = await prisma.propertyHolding.deleteMany({ where: { gameId: id } }); steps.push(`propertyHoldings: ${r6.count}`);
      const r7 = await prisma.marketHolding.deleteMany({ where: { gameId: id } }); steps.push(`marketHoldings: ${r7.count}`);
      // Remettre les joueurs à l'état initial
      const players = await prisma.player.findMany({ where: { gameId: id } });
      for (const p of players) {
        await prisma.player.update({ where: { id: p.id }, data: { cash: INITIAL_CASH, netWorth: INITIAL_CASH } });
      }
      // Réinitialiser paramètres économiques courants (status running, repart à maintenant)
      // Inflation reste telle quelle (partie continue) – si tu veux reset inflation aussi, on peut le faire ici
      await prisma.game.update({ where: { id }, data: { status: "running", startedAt: new Date() } });
      return reply.send({ ok: true, gameId: id, steps });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Rejoindre par code en liant le joueur au cookie invité
  app.post("/api/games/code/:code/join", { preHandler: requireUser(app) }, async (req, reply) => {
    const paramsSchema = z.object({ code: z.string() });
  const bodySchema = z.object({ nickname: z.string().min(2).optional() });
    const { code } = paramsSchema.parse((req as any).params);
  bodySchema.parse((req as any).body ?? {});

    const game = await prisma.game.findUnique({ where: { code: code.toUpperCase() } });
  if (!game) return reply.status(404).send({ error: "Game not found" });
  // Partie unique: autoriser le join même si la partie est en cours

    let guestId = (req as any).cookies?.["hm_guest"] as string | undefined;
    if (!guestId) {
      const { nanoid } = await import("nanoid");
      guestId = nanoid();
  (reply as any).setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "none", secure: true, maxAge: 60 * 60 * 24 * 365 });
    }

  const userEmail = (req as any).user?.email as string;
  const trimmed = String(userEmail || "").trim();
    const existingByNickname = await prisma.player.findFirst({ where: { gameId: game.id, nickname: { equals: trimmed, mode: 'insensitive' } }, select: { id: true, guestId: true } });
    const existingByGuest = await prisma.player.findUnique({ where: { gameId_guestId: { gameId: game.id, guestId } }, select: { id: true } });
    let playerId: string;
    if (existingByNickname) {
      playerId = existingByNickname.id;
      if (existingByNickname.guestId && existingByNickname.guestId !== guestId) {
  (reply as any).setCookie?.("hm_guest", existingByNickname.guestId, { path: "/", httpOnly: true, sameSite: "none", secure: true, maxAge: 60 * 60 * 24 * 365 });
      }
    } else {
      const created = await prisma.player.upsert({
        where: { gameId_guestId: { gameId: game.id, guestId } },
        update: { nickname: trimmed },
        create: { nickname: trimmed, cash: INITIAL_CASH, netWorth: INITIAL_CASH, gameId: game.id, guestId, quizTokens: 15 },
        select: { id: true },
      });
      playerId = created.id;
    }
    (app as any).io?.emit("lobby-update", { type: "joined", gameId: game.id });
    return reply.send({ playerId, gameId: game.id, code: game.code });
  });

  // Démarrer une partie
  app.post("/api/games/:id/start", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    const game = await prisma.game.update({ where: { id }, data: { status: "running", startedAt: new Date() } });
    (app as any).io?.emit("lobby-update", { type: "started", gameId: game.id });
    return reply.send({ id: game.id, status: game.status });
  });

  // Avancer la partie d'un certain nombre de semaines (1 tick = 1 semaine de jeu)
  // Usage: POST /api/games/:id/advance-weeks?weeks=4  (admin uniquement)
  // Limite de sécurité: max 520 semaines (~10 ans de jeu) par appel
  app.post("/api/games/:id/advance-weeks", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const querySchema = z.object({ weeks: z.coerce.number().min(1).max(520).default(4) });
    try {
      const { id } = paramsSchema.parse((req as any).params);
      const { weeks } = querySchema.parse((req as any).query ?? {});
      const game = await prisma.game.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!game) return reply.status(404).send({ error: "Game introuvable" });
      if (game.status !== "running") return reply.status(409).send({ error: "La partie n'est pas en cours" });

      const started = Date.now();
      for (let i = 0; i < weeks; i++) {
        await hourlyTick(id);
      }
      const ms = Date.now() - started;
      return reply.send({ ok: true, gameId: id, weeksApplied: weeks, durationMs: ms });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur avance semaines";
      return reply.status(400).send({ error: message });
    }
  });

  // Endpoint temporaire: restart sans transaction (contourne les problèmes de timeout)
  app.post("/api/games/:id/restart-direct", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const bodySchema = z.object({ confirm: z.boolean().optional() });
    const { id } = paramsSchema.parse((req as any).params);
    const { confirm } = bodySchema.parse((req as any).body ?? {});
    if (!confirm) {
      return reply.status(400).send({ error: "Confirmation requise. Ajoutez {confirm:true}" });
    }
    
    try {
      const steps: string[] = [];
      
      // Supprimer sans transaction (une requête à la fois)
      app.log.info({ gameId: id }, "Suppression listings...");
      const r1 = await prisma.listing.deleteMany({ where: { gameId: id } });
      steps.push(`listings: ${r1.count}`);
      
      app.log.info({ gameId: id }, "Suppression dividendLogs...");
      const r2 = await prisma.dividendLog.deleteMany({ where: { gameId: id } });
      steps.push(`dividendLogs: ${r2.count}`);
      
      app.log.info({ gameId: id }, "Suppression repairEvents...");
      const r3 = await prisma.repairEvent.deleteMany({ where: { holding: { gameId: id } } });
      steps.push(`repairEvents: ${r3.count}`);
      
      app.log.info({ gameId: id }, "Suppression refinanceLogs...");
      const r4 = await prisma.refinanceLog.deleteMany({ where: { holding: { gameId: id } } });
      steps.push(`refinanceLogs: ${r4.count}`);
      
      app.log.info({ gameId: id }, "Suppression propertyHoldings...");
      const r5 = await prisma.propertyHolding.deleteMany({ where: { gameId: id } });
      steps.push(`propertyHoldings: ${r5.count}`);
      
      app.log.info({ gameId: id }, "Suppression marketHoldings...");
      const r6 = await prisma.marketHolding.deleteMany({ where: { gameId: id } });
      steps.push(`marketHoldings: ${r6.count}`);
      
      app.log.info({ gameId: id }, "Suppression marketTicks...");
      const r7 = await prisma.marketTick.deleteMany({ where: { gameId: id } });
      steps.push(`marketTicks: ${r7.count}`);
      
      app.log.info({ gameId: id }, "Suppression players...");
      const r8 = await prisma.player.deleteMany({ where: { gameId: id } });
      steps.push(`players: ${r8.count}`);
      
      app.log.info({ gameId: id }, "Mise à jour game status...");
      await prisma.game.update({ where: { id }, data: { status: "running", startedAt: new Date() } });
      steps.push(`game updated`);
      
      (app as any).io?.emit("lobby-update", { type: "restarted", gameId: id });
      app.log.info({ gameId: id, steps }, "Restart direct réussi");
      return reply.send({ id, status: "running", restartedAt: new Date().toISOString(), steps });
    } catch (err: any) {
      app.log.error({ err, gameId: id }, "Erreur restart direct");
      return reply.status(500).send({ 
        error: "Erreur lors du redémarrage", 
        details: err.message,
        code: err.code 
      });
    }
  });

  // Redémarrer une partie (efface les données de la partie) — confirmation requise
  app.post("/api/games/:id/restart", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const bodySchema = z.object({ confirm: z.boolean().optional() });
    const { id } = paramsSchema.parse((req as any).params);
    const { confirm } = bodySchema.parse((req as any).body ?? {});
    if (!confirm) {
      return reply.status(400).send({ error: "Cette action va effacer les joueurs, annonces, positions et ticks du marché de la partie. Ajoutez {confirm:true} pour continuer." });
    }
    
    try {
      // Effacer proprement les données liées à la partie
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Ordre important: supprimer d'abord les tables qui référencent d'autres tables
        app.log.info({ gameId: id }, "Suppression listings...");
        await tx.listing.deleteMany({ where: { gameId: id } });
        
        app.log.info({ gameId: id }, "Suppression dividendLogs...");
        await tx.dividendLog.deleteMany({ where: { gameId: id } });
        
        app.log.info({ gameId: id }, "Suppression repairEvents...");
        await tx.repairEvent.deleteMany({ where: { holding: { gameId: id } } });
        
        app.log.info({ gameId: id }, "Suppression refinanceLogs...");
        await tx.refinanceLog.deleteMany({ where: { holding: { gameId: id } } });
        
        app.log.info({ gameId: id }, "Suppression propertyHoldings...");
        await tx.propertyHolding.deleteMany({ where: { gameId: id } });
        
        app.log.info({ gameId: id }, "Suppression marketHoldings...");
        await tx.marketHolding.deleteMany({ where: { gameId: id } });
        
        app.log.info({ gameId: id }, "Suppression marketTicks...");
        await tx.marketTick.deleteMany({ where: { gameId: id } });

        // Supprimer sessions quiz, attempts et vues de questions pour un reset complet
        app.log.info({ gameId: id }, "Suppression quizSessions...");
        await tx.quizSession.deleteMany({ where: { gameId: id } });
        app.log.info({ gameId: id }, "Suppression quizQuestionSeen...");
        await tx.quizQuestionSeen.deleteMany({ where: { player: { gameId: id } } });
        app.log.info({ gameId: id }, "Suppression quizAttempts...");
        await tx.quizAttempt.deleteMany({ where: { session: { gameId: id } } });
        // Supprimer invitations de parrainage
        app.log.info({ gameId: id }, "Suppression referralInvites...");
        await tx.referralInvite.deleteMany({ where: { gameId: id } });
        
        app.log.info({ gameId: id }, "Suppression players...");
        await tx.player.deleteMany({ where: { gameId: id } });
        
        app.log.info({ gameId: id }, "Mise à jour game status...");
        const infl = 0.01 + Math.random() * 0.04; // nouveau cycle inflation 1%..5%
        await tx.game.update({ where: { id }, data: { status: "running", startedAt: new Date(), inflationAnnual: infl, inflationIndex: 1 } as any });
      });
      
      (app as any).io?.emit("lobby-update", { type: "restarted", gameId: id });
      app.log.info({ gameId: id }, "Restart réussi");
      return reply.send({ id, status: "running", restartedAt: new Date().toISOString() });
    } catch (err: any) {
      app.log.error({ err, gameId: id }, "Erreur lors du restart");
      return reply.status(500).send({ 
        error: "Erreur lors du redémarrage", 
        details: err.message,
        code: err.code 
      });
    }
  });

  // Supprimer un joueur (admin) et toutes ses données liées à la partie
  app.delete("/api/games/:id/players/:playerId", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string(), playerId: z.string() });
    const { id, playerId } = paramsSchema.parse((req as any).params);
    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player || player.gameId !== id) return reply.status(404).send({ error: "Player not found" });

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Récupérer les holdings du joueur pour nettoyer les annonces liées à ces holdings
  const ph = await tx.propertyHolding.findMany({ where: { gameId: id, playerId }, select: { id: true } });
  const holdingIds = ph.map((h: { id: string }) => h.id);
      if (holdingIds.length > 0) {
        await tx.listing.deleteMany({ where: { OR: [{ sellerId: playerId }, { holdingId: { in: holdingIds } }] } });
        await tx.repairEvent.deleteMany({ where: { holding: { id: { in: holdingIds } } } });
        await tx.refinanceLog.deleteMany({ where: { holding: { id: { in: holdingIds } } } });
      } else {
        await tx.listing.deleteMany({ where: { sellerId: playerId } });
      }
      await tx.marketHolding.deleteMany({ where: { gameId: id, playerId } });
      await tx.propertyHolding.deleteMany({ where: { gameId: id, playerId } });
      await tx.player.delete({ where: { id: playerId } });
    });
    (app as any).io?.emit("lobby-update", { type: "player-removed", gameId: id, playerId });
    return reply.send({ ok: true });
  });

  // État de la partie
  app.get("/api/games/:id/state", async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    const game = await prisma.game.findUnique({
      where: { id },
      include: { players: true },
    });
    if (!game) return reply.status(404).send({ error: "Game not found" });
    return reply.send({
      id: game.id,
      code: game.code,
      status: game.status,
      startedAt: game.startedAt,
      players: game.players.map((p: typeof game.players[number]) => ({
        id: p.id,
        nickname: p.nickname,
        cash: p.cash,
        netWorth: p.netWorth,
      })),
      serverTime: new Date().toISOString(),
    });
  });

  // Résumé de fin de partie
  app.get("/api/games/:id/summary", async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    const game = await prisma.game.findUnique({ where: { id }, include: { players: true } });
    if (!game) return reply.status(404).send({ error: "Game not found" });
    const leaderboard = [...game.players]
      .map((p) => ({ playerId: p.id, nickname: p.nickname, netWorth: p.netWorth }))
      .sort((a, b) => b.netWorth - a.netWorth);
    const winner = leaderboard[0] ?? null;
    return reply.send({ id: game.id, code: game.code, status: game.status, winner, leaderboard });
  });

  // Récupérer mon joueur courant (via cookie invité) pour une partie
  app.get("/api/games/:id/me", async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    
    // Support header X-Player-ID pour iOS/Safari
    const playerIdHeader = req.headers['x-player-id'] as string | undefined;
    let player;
    
    if (playerIdHeader) {
      // Fallback iOS: chercher directement par playerId
      player = await prisma.player.findFirst({
        where: { id: playerIdHeader, gameId: id },
        select: { id: true, nickname: true, cash: true, netWorth: true },
      });
    } else {
      // Standard: utiliser cookie guest
      const guestId = (req as any).cookies?.["hm_guest"] as string | undefined;
      if (guestId) {
        player = await prisma.player.findUnique({
          where: { gameId_guestId: { gameId: id, guestId } },
          select: { id: true, nickname: true, cash: true, netWorth: true },
        });
      }
    }
    
    if (!player) return reply.status(404).send({ error: "Player not found" });
    return reply.send({ player });
  });

  // Endpoint de diagnostic admin: compter les lignes dans chaque table pour une partie
  app.get("/api/games/:id/diagnostic", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    
    const counts = {
      listings: await prisma.listing.count({ where: { gameId: id } }),
      dividendLogs: await prisma.dividendLog.count({ where: { gameId: id } }),
      repairEvents: await prisma.repairEvent.count({ where: { holding: { gameId: id } } }),
      refinanceLogs: await prisma.refinanceLog.count({ where: { holding: { gameId: id } } }),
      propertyHoldings: await prisma.propertyHolding.count({ where: { gameId: id } }),
      marketHoldings: await prisma.marketHolding.count({ where: { gameId: id } }),
      marketTicks: await prisma.marketTick.count({ where: { gameId: id } }),
      players: await prisma.player.count({ where: { gameId: id } }),
    };
    
    return reply.send({ gameId: id, counts });
  });

  // Endpoint admin: nettoyer les vieux ticks de marché avec échantillonnage
  // Stratégie: garder les 100 derniers ticks complets + 1 tick sur 100 des anciens (historique long terme)
  app.post("/api/games/:id/cleanup-ticks", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    
    try {
      const totalDeleted = await cleanupMarketTicks(id);
      app.log.info({ gameId: id, totalDeleted }, "Nettoyage ticks terminé");
      return reply.send({ ok: true, totalDeleted });
    } catch (err: any) {
      app.log.error({ err }, "Erreur nettoyage ticks");
      return reply.status(500).send({ error: err.message });
    }
  });
}

function generateCode() {
  return codeGenerator();
}
