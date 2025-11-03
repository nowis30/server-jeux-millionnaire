import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { z } from "zod";
import { INITIAL_CASH } from "../shared/constants";
import { customAlphabet } from "nanoid";
import { requireAdmin } from "./auth";

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
        (reply as any).setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
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
  app.post("/api/games/:id/join", async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const bodySchema = z.object({ nickname: z.string().min(2) });
    const { id } = paramsSchema.parse((req as any).params);
    const { nickname } = bodySchema.parse((req as any).body);

    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) return reply.status(404).send({ error: "Game not found" });
  // Partie unique: autoriser le join même si la partie est en cours

    let guestId = (req as any).cookies?.["hm_guest"] as string | undefined;
    if (!guestId) {
      const { nanoid } = await import("nanoid");
      guestId = nanoid();
      (reply as any).setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
    }

    const trimmed = nickname.trim();
    // Refuser doublon de pseudo dans la même partie (insensible à la casse)
    const existingByNickname = await prisma.player.findFirst({ where: { gameId: id, nickname: { equals: trimmed, mode: 'insensitive' } }, select: { id: true, guestId: true } });
    const existingByGuest = await prisma.player.findUnique({ where: { gameId_guestId: { gameId: id, guestId } }, select: { id: true } });
    if (existingByNickname && (!existingByGuest || existingByNickname.id !== existingByGuest.id)) {
      return reply.status(409).send({ error: "Pseudo déjà utilisé dans cette partie" });
    }
    const player = await prisma.player.upsert({
      where: { gameId_guestId: { gameId: id, guestId } },
      update: { nickname: trimmed },
      create: { nickname: trimmed, cash: INITIAL_CASH, netWorth: INITIAL_CASH, gameId: id, guestId },
      select: { id: true },
    });
    (app as any).io?.emit("lobby-update", { type: "joined", gameId: id });
    return reply.send({ playerId: player.id, gameId: id, code: game.code });
  });

  // Rejoindre par code en liant le joueur au cookie invité
  app.post("/api/games/code/:code/join", async (req, reply) => {
    const paramsSchema = z.object({ code: z.string() });
    const bodySchema = z.object({ nickname: z.string().min(2) });
    const { code } = paramsSchema.parse((req as any).params);
    const { nickname } = bodySchema.parse((req as any).body);

    const game = await prisma.game.findUnique({ where: { code: code.toUpperCase() } });
  if (!game) return reply.status(404).send({ error: "Game not found" });
  // Partie unique: autoriser le join même si la partie est en cours

    let guestId = (req as any).cookies?.["hm_guest"] as string | undefined;
    if (!guestId) {
      const { nanoid } = await import("nanoid");
      guestId = nanoid();
      (reply as any).setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
    }

    const trimmed = nickname.trim();
    const existingByNickname = await prisma.player.findFirst({ where: { gameId: game.id, nickname: { equals: trimmed, mode: 'insensitive' } }, select: { id: true, guestId: true } });
    const existingByGuest = await prisma.player.findUnique({ where: { gameId_guestId: { gameId: game.id, guestId } }, select: { id: true } });
    if (existingByNickname && (!existingByGuest || existingByNickname.id !== existingByGuest.id)) {
      return reply.status(409).send({ error: "Pseudo déjà utilisé dans cette partie" });
    }
    const player = await prisma.player.upsert({
      where: { gameId_guestId: { gameId: game.id, guestId } },
      update: { nickname: trimmed },
      create: { nickname: trimmed, cash: INITIAL_CASH, netWorth: INITIAL_CASH, gameId: game.id, guestId },
      select: { id: true },
    });
    (app as any).io?.emit("lobby-update", { type: "joined", gameId: game.id });
    return reply.send({ playerId: player.id, gameId: game.id, code: game.code });
  });

  // Démarrer une partie
  app.post("/api/games/:id/start", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse((req as any).params);
    const game = await prisma.game.update({ where: { id }, data: { status: "running", startedAt: new Date() } });
    (app as any).io?.emit("lobby-update", { type: "started", gameId: game.id });
    return reply.send({ id: game.id, status: game.status });
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
}

function generateCode() {
  return codeGenerator();
}
