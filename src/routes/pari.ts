import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireUserOrGuest } from "./auth";

function roll3(): [number, number, number] {
  return [1,2,3].map(() => Math.floor(Math.random()*6)+1) as [number,number,number];
}

interface Outcome {
  type: 'perte' | 'double' | 'triple' | 'suite' | 'aucun';
  multiplier: number; // 0 = perdu, 1 = aucun (perte car on retire la mise), >1 = gain multiplicatif sur la mise
  description: string;
}

function evaluateDice([a,b,c]: [number,number,number]): Outcome {
  const sorted = [a,b,c].sort((x,y)=>x-y);
  const isTriple = a===b && b===c;
  const isDouble = (a===b||a===c||b===c) && !isTriple;
  const isSuite = (sorted[0]+1===sorted[1] && sorted[1]+1===sorted[2]);
  if (isTriple) return { type:'triple', multiplier:3, description:'Triple! x3' };
  if (isSuite) return { type:'suite', multiplier:3, description:'Suite consécutive! x3' };
  if (isDouble) return { type:'double', multiplier:2, description:'Double! x2' };
  return { type:'aucun', multiplier:0, description:'Aucun combo gagnant' };
}

export async function registerPariRoutes(app: FastifyInstance) {
  // POST /api/games/:gameId/pari/play  { bet }
  app.post('/api/games/:gameId/pari/play', { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({ bet: z.number().int().positive() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const { bet } = bodySchema.parse((req as any).body);
    const user = (req as any).user;

    const MIN_BET = 5000;
    if (bet < MIN_BET) {
      return reply.status(400).send({ error: `Mise minimum ${MIN_BET}` });
    }

    // Résolution du joueur comme dans quiz (priorité header, middleware, guestId)
    const playerIdHeader = req.headers['x-player-id'] as string | undefined;
    const playerIdFromMiddleware = user.playerIdFromHeader as string | undefined;
    let player = null as any;
    if (playerIdHeader) {
      player = await prisma.player.findFirst({ where: { id: playerIdHeader, gameId } });
    } else if (playerIdFromMiddleware) {
      player = await prisma.player.findFirst({ where: { id: playerIdFromMiddleware, gameId } });
    } else if (user.guestId) {
      player = await prisma.player.findFirst({ where: { gameId, guestId: user.guestId } });
    }
    if (!player) return reply.status(404).send({ error: 'Joueur non trouvé' });

    if (player.cash < bet) {
      return reply.status(400).send({ error: 'Cash insuffisant' });
    }

    // Débiter la mise immédiatement
    await prisma.player.update({ where: { id: player.id }, data: { cash: { decrement: bet }, netWorth: { decrement: bet } } });

    const dice = roll3();
    const outcome = evaluateDice(dice);
    let gain = 0;
    if (outcome.multiplier > 0) {
      gain = bet * outcome.multiplier;
      await prisma.player.update({ where: { id: player.id }, data: { cash: { increment: gain }, netWorth: { increment: gain } } });
    }

    return reply.send({
      dice,
      combination: outcome.type,
      description: outcome.description,
      bet,
      gain,
      netResult: gain - bet, // positif si gagnant, négatif si perdu
      finalCash: (await prisma.player.findUnique({ where: { id: player.id }, select: { cash: true } }))?.cash,
    });
  });
}
