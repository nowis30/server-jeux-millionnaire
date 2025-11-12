import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireUserOrGuest } from "./auth";
import { resolvePlayerForRequest } from "./helpers/player";

// Paramètres serveurs (faciles à ajuster)
const DRAG_BASE_REWARD = 50_000; // cohérent avec le client drag
const DRAG_REWARD_COOLDOWN_MS = 5_000; // anti‑spam basique entre 2 runs
const DRAG_MIN_TIME_MS_STAGE1 = 5500; // temps minimal plausible à l'étape 1
const DRAG_MIN_TIME_REDUCTION_PER_STAGE = 50; // assouplissement progressif
const DRAG_MIN_TIME_FLOOR_MS = 4000; // jamais en‑dessous

function minPlausibleTimeMs(stage: number): number {
  const reduce = Math.max(0, (stage - 1)) * DRAG_MIN_TIME_REDUCTION_PER_STAGE;
  return Math.max(DRAG_MIN_TIME_FLOOR_MS, DRAG_MIN_TIME_MS_STAGE1 - reduce);
}

function computeReward(win: boolean, _stage: number, _perfectShifts: number): number {
  // Itération 1: constante, simple et alignée avec le client (50k)
  return win ? DRAG_BASE_REWARD : 0;
}

export async function registerDragRoutes(app: FastifyInstance) {
  // GET /api/games/:gameId/drag/session
  app.get("/api/games/:gameId/drag/session", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);

    const player = await resolvePlayerForRequest(app, req, gameId);
    if (!player) return reply.status(404).send({ error: "Player not found" });

    // Lire progression (via Prisma any pour compat compatibilité si client non régénéré)
    const p = await (prisma as any).player.findUnique({
      where: { id: player.id },
      select: { id: true, nickname: true, cash: true, netWorth: true, dragStage: true, dragLastRewardAt: true },
    });
    const now = Date.now();
    const last = p?.dragLastRewardAt ? new Date(p.dragLastRewardAt).getTime() : 0;
    const remaining = Math.max(0, Math.ceil((DRAG_REWARD_COOLDOWN_MS - (now - last)) / 1000));

    return reply.send({
      player: { id: p.id, nickname: p.nickname, cash: p.cash, netWorth: p.netWorth },
      drag: {
        stage: Number(p.dragStage ?? 1),
        tuning: { engineMax: 1.6, nitroPowerMax: 1.8, nitroChargesMax: 3 },
        cooldowns: { rewardCooldownSeconds: remaining },
      },
    });
  });

  // POST /api/games/:gameId/drag/result
  app.post("/api/games/:gameId/drag/result", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({
      stage: z.number().int().min(1).max(200),
      elapsedMs: z.number().int().min(1_000).max(60_000),
      win: z.boolean(),
      perfectShifts: z.number().int().min(0).max(8),
      reward: z.number().int().min(0).max(200_000).optional(),
      tuning: z.record(z.any()).optional(),
      device: z.object({ platform: z.string().max(32), build: z.string().max(64) }).optional(),
    });
    const { gameId } = paramsSchema.parse((req as any).params);
    const body = bodySchema.parse((req as any).body ?? {});

    const player = await resolvePlayerForRequest(app, req, gameId);
    if (!player) return reply.status(404).send({ error: "Player not found" });

    // Récupérer progression + timestamps anti‑abus
    const full = await (prisma as any).player.findUnique({
      where: { id: player.id },
      select: { id: true, cash: true, netWorth: true, dragStage: true, dragLastRewardAt: true, dragLastRunAt: true },
    });
    const currentStage = Number(full?.dragStage ?? 1);

    // Étape plausible (ne pas sauter vers l'avant)
    if (body.stage > currentStage) {
      return reply.status(400).send({ error: "Stage non débloqué" });
    }

    // Anti‑spam de runs
    const now = Date.now();
    const lastRun = full?.dragLastRunAt ? new Date(full.dragLastRunAt).getTime() : 0;
    if (now - lastRun < 1000) {
      return reply.status(429).send({ error: "Runs trop rapprochés, réessayez" });
    }

    // Temps plausible par étape
    const minTime = minPlausibleTimeMs(body.stage);
    if (body.elapsedMs < minTime) {
      return reply.status(400).send({ error: "Temps de course improbable" });
    }

    // Cooldown pour récompense
    const lastReward = full?.dragLastRewardAt ? new Date(full.dragLastRewardAt).getTime() : 0;
    const canReward = now - lastReward >= DRAG_REWARD_COOLDOWN_MS;

    // Calcul récompense (ignorons la valeur client et imposons la nôtre)
    const computed = computeReward(body.win, body.stage, body.perfectShifts);
    const granted = body.win && canReward ? computed : 0;

    // Enregistrer atomiquement: log + mise à jour joueur
    const deviceInfo = body.device || body.tuning ? JSON.stringify({ device: body.device, tuning: body.tuning }) : undefined;
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const run = await tx.dragRun.create({
        data: {
          playerId: full.id,
          gameId,
          stage: body.stage,
          elapsedMs: body.elapsedMs,
          win: body.win,
          perfectShifts: body.perfectShifts,
          reward: Number(body.reward ?? 0),
          grantedReward: granted,
          deviceInfo,
        },
        select: { id: true, createdAt: true },
      });

      // Préparer mise à jour Player
      const data: any = { dragLastRunAt: new Date(now) };
      if (granted > 0) {
        data.cash = { increment: granted };
        data.netWorth = { increment: granted };
        data.dragLastRewardAt = new Date(now);
      }
      // Si victoire sur l'étape courante, débloquer la suivante
      if (body.win && body.stage >= currentStage) {
        data.dragStage = currentStage + 1;
      }
      await tx.player.update({ where: { id: full.id }, data });

      const updated = await tx.player.findUnique({ where: { id: full.id }, select: { cash: true, netWorth: true, dragStage: true } });
      return { run, updated };
    });

    return reply.send({
      ok: true,
      grantedReward: granted,
      player: { cash: result.updated.cash, netWorth: result.updated.netWorth },
      drag: { stage: Number(result.updated.dragStage ?? currentStage) },
      cooldowns: {
        rewardCooldownSeconds: Math.ceil(DRAG_REWARD_COOLDOWN_MS / 1000),
      },
    });
  });

  // GET /api/games/:gameId/drag/history?limit=20
  app.get("/api/games/:gameId/drag/history", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
    const { gameId } = paramsSchema.parse((req as any).params);
    const { limit } = querySchema.parse((req as any).query ?? {});

    const player = await resolvePlayerForRequest(app, req, gameId);
    if (!player) return reply.status(404).send({ error: "Player not found" });

    const runs = await (prisma as any).dragRun.findMany({
      where: { playerId: player.id, gameId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { stage: true, elapsedMs: true, win: true, perfectShifts: true, grantedReward: true, createdAt: true },
    });
    return reply.send({ history: runs });
  });
}
