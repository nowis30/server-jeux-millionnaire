import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireUserOrGuest } from "./auth";
import { resolvePlayerForRequest } from "./helpers/player";

const BONUS_AMOUNT = 1_000_000;
const BONUS_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export async function registerBonusRoutes(app: FastifyInstance) {
  const paramsSchema = z.object({ gameId: z.string() });

  app.get("/api/games/:gameId/bonus/status", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const { gameId } = paramsSchema.parse((req as any).params);
    const player = await resolvePlayerForRequest(app, req, gameId);
    if (!player) return reply.status(404).send({ error: "Player not found" });

    const now = Date.now();
    const last = player.lastAdQuizAt ? new Date(player.lastAdQuizAt).getTime() : 0;
    const nextAvailableAt = last + BONUS_COOLDOWN_MS;
    const secondsUntilAvailable = Math.max(0, Math.ceil((nextAvailableAt - now) / 1000));

    return reply.send({
      available: secondsUntilAvailable === 0,
      secondsUntilAvailable,
      rewardAmount: BONUS_AMOUNT,
      lastAdAt: player.lastAdQuizAt,
    });
  });

  app.post("/api/games/:gameId/bonus/redeem", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const { gameId } = paramsSchema.parse((req as any).params);
    const player = await resolvePlayerForRequest(app, req, gameId);
    if (!player) return reply.status(404).send({ error: "Player not found" });

    const now = Date.now();
    const last = player.lastAdQuizAt ? new Date(player.lastAdQuizAt).getTime() : 0;
    const remainingMs = last + BONUS_COOLDOWN_MS - now;
    if (remainingMs > 0) {
      return reply.status(429).send({
        error: "Reward cooldown active",
        secondsUntilAvailable: Math.ceil(remainingMs / 1000),
      });
    }

    const updated = await (prisma as any).player.update({
      where: { id: player.id },
      data: {
        cash: { increment: BONUS_AMOUNT },
        netWorth: { increment: BONUS_AMOUNT },
        lastAdQuizAt: new Date(),
      },
      select: {
        cash: true,
        netWorth: true,
        lastAdQuizAt: true,
      },
    });

    return reply.send({
      ok: true,
      rewardAmount: BONUS_AMOUNT,
      cash: updated.cash,
      netWorth: updated.netWorth,
      secondsUntilNext: Math.ceil(BONUS_COOLDOWN_MS / 1000),
      lastAdAt: updated.lastAdQuizAt,
    });
  });
}