import { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { z } from "zod";
import { INITIAL_CASH } from "../shared/constants";
import { customAlphabet } from "nanoid";
import { requireAdmin, requireUser } from "./auth";

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeGenerator = customAlphabet(codeAlphabet, 6);

export async function registerGameRoutes(app: FastifyInstance) {
  app.get("/api/games", async (_req, reply) => {
    const GLOBAL_CODE = process.env.GLOBAL_GAME_CODE || "GLOBAL";
    // Retourner uniquement la partie globale (créer si manquante)
    let g = await prisma.game.findUnique({ where: { code: GLOBAL_CODE }, include: { players: true } });
    if (!g) {
      g = await prisma.game.create({ data: { code: GLOBAL_CODE, status: "running", startedAt: new Date() }, include: { players: true } });
    }
    const payload = [{
      id: g.id,
      code: g.code,
      status: g.status,
      players: g.players.length,
      createdAt: g.createdAt,
    }];
    return reply.send({ games: payload });
  });

  // Créer une partie (option: créer aussi l'hôte pour le cookie invité courant)
  app.post("/api/games", async (req, reply) => {
    const bodySchema = z.object({ hostNickname: z.string().min(2).optional() });
    const { hostNickname } = bodySchema.parse((req as any).body ?? {});
    const GLOBAL_CODE = process.env.GLOBAL_GAME_CODE || "GLOBAL";
    let game = await prisma.game.findUnique({ where: { code: GLOBAL_CODE } });
    if (!game) {
      game = await prisma.game.create({ data: { code: GLOBAL_CODE, status: "running", startedAt: new Date() } });
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
        create: { nickname: trimmed, cash: INITIAL_CASH, netWorth: INITIAL_CASH, gameId: game.id, guestId },
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

    let guestId = (req as any).cookies?.["hm_guest"] as string | undefined;
    if (!guestId) {
      const { nanoid } = await import("nanoid");
      guestId = nanoid();
      (reply as any).setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
    }

  // Pseudo = email obligatoire (lié à l'utilisateur connecté)
  const userEmail = (req as any).user?.email as string;
  const trimmed = String(userEmail || "").trim();
    // Refuser doublon de pseudo dans la même partie (insensible à la casse)
    const existingByNickname = await prisma.player.findFirst({ where: { gameId: id, nickname: { equals: trimmed, mode: 'insensitive' } }, select: { id: true, guestId: true } });
    const existingByGuest = await prisma.player.findUnique({ where: { gameId_guestId: { gameId: id, guestId } }, select: { id: true } });
    let playerId: string;
    if (existingByNickname) {
      // L'utilisateur est authentifié et son pseudo = email. Réutiliser le joueur existant
      // en alignant le cookie invité sur celui déjà associé au joueur.
      playerId = existingByNickname.id;
      if (existingByNickname.guestId && existingByNickname.guestId !== guestId) {
  (reply as any).setCookie?.("hm_guest", existingByNickname.guestId, { path: "/", httpOnly: true, sameSite: "none", secure: true, maxAge: 60 * 60 * 24 * 365 });
      }
    } else {
      const created = await prisma.player.upsert({
        where: { gameId_guestId: { gameId: id, guestId } },
        update: { nickname: trimmed },
        create: { nickname: trimmed, cash: INITIAL_CASH, netWorth: INITIAL_CASH, gameId: id, guestId },
        select: { id: true },
      });
      playerId = created.id;
    }
    (app as any).io?.emit("lobby-update", { type: "joined", gameId: id });
    return reply.send({ playerId, gameId: id, code: game.code });
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
        create: { nickname: trimmed, cash: INITIAL_CASH, netWorth: INITIAL_CASH, gameId: game.id, guestId },
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
        
        app.log.info({ gameId: id }, "Suppression players...");
        await tx.player.deleteMany({ where: { gameId: id } });
        
        app.log.info({ gameId: id }, "Mise à jour game status...");
        await tx.game.update({ where: { id }, data: { status: "running", startedAt: new Date() } });
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
  const guestId = (req as any).cookies?.["hm_guest"] as string | undefined;
  if (!guestId) return reply.status(404).send({ error: "Player not found" });
    const player = await prisma.player.findUnique({
      where: { gameId_guestId: { gameId: id, guestId } },
      select: { id: true, nickname: true, cash: true, netWorth: true },
    });
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
}

function generateCode() {
  return codeGenerator();
}
