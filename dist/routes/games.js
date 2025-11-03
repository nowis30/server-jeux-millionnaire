"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGameRoutes = registerGameRoutes;
const prisma_1 = require("../prisma");
const zod_1 = require("zod");
const shared_1 = require("@hm/shared");
const nanoid_1 = require("nanoid");
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeGenerator = (0, nanoid_1.customAlphabet)(codeAlphabet, 6);
async function registerGameRoutes(app) {
    app.get("/api/games", async (req, reply) => {
        const querySchema = zod_1.z.object({ status: zod_1.z.string().optional() });
        const { status } = querySchema.parse(req.query ?? {});
        const where = status ? { status } : {};
        const games = await prisma_1.prisma.game.findMany({
            where,
            orderBy: { createdAt: "desc" },
            include: { players: true },
            take: 25,
        });
        const payload = games.map((g) => ({
            id: g.id,
            code: g.code,
            status: g.status,
            players: g.players.length,
            createdAt: g.createdAt,
        }));
        return reply.send({ games: payload });
    });
    // Créer une partie (option: créer aussi l'hôte pour le cookie invité courant)
    app.post("/api/games", async (req, reply) => {
        const bodySchema = zod_1.z.object({ code: zod_1.z.string().optional(), hostNickname: zod_1.z.string().min(2).optional() });
        const { code, hostNickname } = bodySchema.parse(req.body ?? {});
        const desiredCode = (code ?? generateCode()).toUpperCase();
        const existing = await prisma_1.prisma.game.findUnique({ where: { code: desiredCode } });
        if (existing)
            return reply.status(409).send({ error: "Code déjà utilisé" });
        const game = await prisma_1.prisma.game.create({
            data: {
                code: desiredCode,
                status: "lobby",
            },
        });
        // Notifier le lobby en temps réel
        app.io?.emit("lobby-update", { type: "created", gameId: game.id, code: game.code });
        // Si un hostNickname est fourni, créer/associer le joueur hôte à ce cookie
        let guestId = req.cookies?.["hm_guest"];
        let hostPlayer;
        if (hostNickname && guestId) {
            hostPlayer = await prisma_1.prisma.player.upsert({
                where: { gameId_guestId: { gameId: game.id, guestId } },
                update: { nickname: hostNickname.trim() },
                create: { nickname: hostNickname.trim(), cash: shared_1.INITIAL_CASH, netWorth: shared_1.INITIAL_CASH, gameId: game.id, guestId },
                select: { id: true },
            });
        }
        if (hostNickname && !guestId) {
            const { nanoid } = await Promise.resolve().then(() => __importStar(require("nanoid")));
            guestId = nanoid();
            reply.setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
            hostPlayer = await prisma_1.prisma.player.upsert({
                where: { gameId_guestId: { gameId: game.id, guestId } },
                update: { nickname: hostNickname.trim() },
                create: { nickname: hostNickname.trim(), cash: shared_1.INITIAL_CASH, netWorth: shared_1.INITIAL_CASH, gameId: game.id, guestId },
                select: { id: true },
            });
        }
        return reply.send({ id: game.id, code: game.code, status: game.status, playerId: hostPlayer?.id });
    });
    // Rejoindre une partie (par id) en liant le joueur au cookie invité
    app.post("/api/games/:id/join", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ id: zod_1.z.string() });
        const bodySchema = zod_1.z.object({ nickname: zod_1.z.string().min(2) });
        const { id } = paramsSchema.parse(req.params);
        const { nickname } = bodySchema.parse(req.body);
        const game = await prisma_1.prisma.game.findUnique({ where: { id } });
        if (!game)
            return reply.status(404).send({ error: "Game not found" });
        if (game.status !== "lobby")
            return reply.status(400).send({ error: "Game already started" });
        let guestId = req.cookies?.["hm_guest"];
        if (!guestId) {
            const { nanoid } = await Promise.resolve().then(() => __importStar(require("nanoid")));
            guestId = nanoid();
            reply.setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
        }
        const player = await prisma_1.prisma.player.upsert({
            where: { gameId_guestId: { gameId: id, guestId } },
            update: { nickname: nickname.trim() },
            create: { nickname: nickname.trim(), cash: shared_1.INITIAL_CASH, netWorth: shared_1.INITIAL_CASH, gameId: id, guestId },
            select: { id: true },
        });
        app.io?.emit("lobby-update", { type: "joined", gameId: id });
        return reply.send({ playerId: player.id, gameId: id, code: game.code });
    });
    // Rejoindre par code en liant le joueur au cookie invité
    app.post("/api/games/code/:code/join", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ code: zod_1.z.string() });
        const bodySchema = zod_1.z.object({ nickname: zod_1.z.string().min(2) });
        const { code } = paramsSchema.parse(req.params);
        const { nickname } = bodySchema.parse(req.body);
        const game = await prisma_1.prisma.game.findUnique({ where: { code: code.toUpperCase() } });
        if (!game)
            return reply.status(404).send({ error: "Game not found" });
        if (game.status !== "lobby")
            return reply.status(400).send({ error: "Game already started" });
        let guestId = req.cookies?.["hm_guest"];
        if (!guestId) {
            const { nanoid } = await Promise.resolve().then(() => __importStar(require("nanoid")));
            guestId = nanoid();
            reply.setCookie?.("hm_guest", guestId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
        }
        const player = await prisma_1.prisma.player.upsert({
            where: { gameId_guestId: { gameId: game.id, guestId } },
            update: { nickname: nickname.trim() },
            create: { nickname: nickname.trim(), cash: shared_1.INITIAL_CASH, netWorth: shared_1.INITIAL_CASH, gameId: game.id, guestId },
            select: { id: true },
        });
        app.io?.emit("lobby-update", { type: "joined", gameId: game.id });
        return reply.send({ playerId: player.id, gameId: game.id, code: game.code });
    });
    // Démarrer une partie
    app.post("/api/games/:id/start", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ id: zod_1.z.string() });
        const { id } = paramsSchema.parse(req.params);
        const game = await prisma_1.prisma.game.update({ where: { id }, data: { status: "running", startedAt: new Date() } });
        app.io?.emit("lobby-update", { type: "started", gameId: game.id });
        return reply.send({ id: game.id, status: game.status });
    });
    // État de la partie
    app.get("/api/games/:id/state", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ id: zod_1.z.string() });
        const { id } = paramsSchema.parse(req.params);
        const game = await prisma_1.prisma.game.findUnique({
            where: { id },
            include: { players: true },
        });
        if (!game)
            return reply.status(404).send({ error: "Game not found" });
        return reply.send({
            id: game.id,
            code: game.code,
            status: game.status,
            startedAt: game.startedAt,
            players: game.players.map((p) => ({
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
        const paramsSchema = zod_1.z.object({ id: zod_1.z.string() });
        const { id } = paramsSchema.parse(req.params);
        const game = await prisma_1.prisma.game.findUnique({ where: { id }, include: { players: true } });
        if (!game)
            return reply.status(404).send({ error: "Game not found" });
        const leaderboard = [...game.players]
            .map((p) => ({ playerId: p.id, nickname: p.nickname, netWorth: p.netWorth }))
            .sort((a, b) => b.netWorth - a.netWorth);
        const winner = leaderboard[0] ?? null;
        return reply.send({ id: game.id, code: game.code, status: game.status, winner, leaderboard });
    });
    // Récupérer mon joueur courant (via cookie invité) pour une partie
    app.get("/api/games/:id/me", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ id: zod_1.z.string() });
        const { id } = paramsSchema.parse(req.params);
        const guestId = req.cookies?.["hm_guest"];
        if (!guestId)
            return reply.status(404).send({ error: "Player not found" });
        const player = await prisma_1.prisma.player.findUnique({
            where: { gameId_guestId: { gameId: id, guestId } },
            select: { id: true, nickname: true, cash: true, netWorth: true },
        });
        if (!player)
            return reply.status(404).send({ error: "Player not found" });
        return reply.send({ player });
    });
}
function generateCode() {
    return codeGenerator();
}
