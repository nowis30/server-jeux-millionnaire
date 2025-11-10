import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { updatePariTokens, consumePariToken, getPariSecondsUntilNext, PARI_MAX_TOKENS, PARI_AD_REWARD } from "../services/pariTokens";
import { QUIZ_AD_REWARD, QUIZ_MAX_TOKENS } from "../services/quizTokens";
import { requireUserOrGuest } from "./auth";
const AD_COOLDOWN_MINUTES = 30;
const AD_COOLDOWN_SECONDS = AD_COOLDOWN_MINUTES * 60;

function computeCooldownSeconds(last: Date | string | null | undefined): number {
  if (!last) return 0;
  const lastDate = typeof last === 'string' ? new Date(last) : last;
  const elapsedMs = Date.now() - lastDate.getTime();
  const windowMs = AD_COOLDOWN_MINUTES * 60 * 1000;
  if (elapsedMs >= windowMs) return 0;
  return Math.max(0, Math.ceil((windowMs - elapsedMs) / 1000));
}

/**
 * Règles du jeu Pari (dés x3) :
 * - Triple (ex: 6-6-6)  => multiplicateur = somme des 3 dés (ex: 6+6+6 = 18)
 *   Justification: gros coup de chance, paiement explosif proportionnel à la valeur.
 * - Double (ex: 4-4-1)  => multiplicateur = valeur du dé répété (ex: 4)
 *   (Ancienne règle x2 ou 2×face abandonnée pour lisibilité et variance réduite).
 * - Suite consécutive (ex: 2-3-4) => multiplicateur = 2 (bonus modéré de skill/chance).
 * - Autre combinaison => 0 (perte de la mise).
 *
 * Le flux: on débite la mise, on calcule outcome, puis on crédite mise × multiplicateur si >0.
 */

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
  if (isTriple) {
    // Triple: multiplicateur = somme des dés (ex: 1+1+1=3, 6+6+6=18)
    const sum = a + b + c;
    return { type:'triple', multiplier: sum, description: `Triple! x${sum}` };
  }
  if (isSuite) return { type:'suite', multiplier:2, description:'Suite consécutive! x2' };
  if (isDouble) {
    // Double: multiplicateur = valeur du dé doublé (ex: 4-4-1 => x4)
    const val = a===b ? a : (a===c ? a : b);
    return { type:'double', multiplier: val, description: `Double de ${val}! x${val}` };
  }
  return { type:'aucun', multiplier:0, description:'Aucun combo gagnant' };
}

export async function registerPariRoutes(app: FastifyInstance) {
  // Statut tokens Pari
  app.get('/api/games/:gameId/pari/status', { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const user = (req as any).user;
    const playerIdHeader = req.headers['x-player-id'] as string | undefined;
    const playerIdFromMiddleware = user.playerIdFromHeader as string | undefined;
    let player: any = null;
    if (playerIdHeader) player = await prisma.player.findFirst({ where: { id: playerIdHeader, gameId } });
    else if (playerIdFromMiddleware) player = await prisma.player.findFirst({ where: { id: playerIdFromMiddleware, gameId } });
    else if (user.guestId) player = await prisma.player.findFirst({ where: { gameId, guestId: user.guestId } });
    if (!player) return reply.status(404).send({ error: 'Joueur non trouvé' });
    const tokens = await updatePariTokens(player.id);
    const secondsUntilNext = await getPariSecondsUntilNext(player.id);
    const adCooldownSeconds = computeCooldownSeconds(player.lastAdPariAt);
    return reply.send({ tokens, max: PARI_MAX_TOKENS, secondsUntilNext, canPlay: tokens > 0, adCooldownSeconds, adReward: PARI_AD_REWARD });
  });

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

    // Plafond dynamique: 50% du cash disponible mais jamais > 50 000 (cap absolu), ni sous le minimum
    const ABS_MAX = 50_000;
    const dynamicCap = Math.min(ABS_MAX, Math.max(MIN_BET, Math.floor(Math.max(0, player.cash) * 0.5)));
    if (bet > dynamicCap) {
      return reply.status(400).send({ error: `Mise trop élevée (max ${dynamicCap} / cap absolu 50K)` });
    }

    if (player.cash < bet) {
      return reply.status(400).send({ error: 'Cash insuffisant' });
    }

    // Consommer 1 token Pari (après mise à jour accumulation)
    const tokenOk = await consumePariToken(player.id);
    if (!tokenOk) {
      return reply.status(403).send({ error: 'Pas assez de tokens Pari (🎟️). Attendez la régénération ou regardez une annonce pour recharger.' });
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
    // Mettre à jour le cumul des gains de pari (gain - mise) => net
    const net = gain - bet;
    try {
      await prisma.player.update({ where: { id: player.id }, data: { cumulativePariGain: { increment: net } } as any });
    } catch {}

  const remainingTokens = (await (prisma as any).player.findUnique({ where: { id: player.id }, select: { pariTokens: true } }))?.pariTokens ?? 0;
    return reply.send({
      dice,
      combination: outcome.type,
      description: outcome.description,
      bet,
      gain,
      netResult: gain - bet, // positif si gagnant, négatif si perdu
      finalCash: (await prisma.player.findUnique({ where: { id: player.id }, select: { cash: true } }))?.cash,
      tokensLeft: remainingTokens,
    });
  });

  // POST /api/games/:gameId/pari/ad-recharge - Recharge via annonce (Pari -> +20, Quiz -> 20 max)
  app.post('/api/games/:gameId/pari/ad-recharge', { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({ type: z.enum(['pari','quiz']) });
    const { gameId } = paramsSchema.parse((req as any).params);
    const { type } = bodySchema.parse((req as any).body);
    const user = (req as any).user;
    const playerIdHeader = req.headers['x-player-id'] as string | undefined;
    const playerIdFromMiddleware = user.playerIdFromHeader as string | undefined;
    let player: any = null;
    if (playerIdHeader) player = await prisma.player.findFirst({ where: { id: playerIdHeader, gameId } });
    else if (playerIdFromMiddleware) player = await prisma.player.findFirst({ where: { id: playerIdFromMiddleware, gameId } });
    else if (user.guestId) player = await prisma.player.findFirst({ where: { gameId, guestId: user.guestId } });
    if (!player) return reply.status(404).send({ error: 'Joueur non trouvé' });

  const NOW = new Date();
    if (type === 'pari') {
      if (player.lastAdPariAt) {
        const diffMin = (NOW.getTime() - new Date(player.lastAdPariAt).getTime()) / 60000;
        if (diffMin < AD_COOLDOWN_MINUTES) {
          const remainMinutes = Math.ceil(AD_COOLDOWN_MINUTES - diffMin);
          const retrySeconds = Math.max(0, Math.ceil((AD_COOLDOWN_MINUTES * 60) - diffMin * 60));
          return reply.status(429).send({ error: `Recharge Pari trop fréquente. Réessayez dans ${remainMinutes} min.`, retrySeconds });
        }
      }
      const current = Number(player.pariTokens ?? 0);
      const next = Math.min(PARI_MAX_TOKENS, current + PARI_AD_REWARD);
      const added = Math.max(0, next - current);
      await (prisma as any).player.update({
        where: { id: player.id },
        data: {
          pariTokens: next,
          lastAdPariAt: NOW,
          ...(added > 0 ? { pariTokensUpdatedAt: NOW } : {}),
        },
      });
      return reply.send({ ok: true, type: 'pari', tokens: next, max: PARI_MAX_TOKENS, added, adReward: PARI_AD_REWARD, cooldownSeconds: AD_COOLDOWN_SECONDS, message: added > 0 ? `+${added} tokens Pari ajoutés ✅` : 'Tokens déjà au maximum ✅' });
    } else {
      if (player.lastAdQuizAt) {
        const diffMin = (NOW.getTime() - new Date(player.lastAdQuizAt).getTime()) / 60000;
        if (diffMin < AD_COOLDOWN_MINUTES) {
          const remainMinutes = Math.ceil(AD_COOLDOWN_MINUTES - diffMin);
          const retrySeconds = Math.max(0, Math.ceil((AD_COOLDOWN_MINUTES * 60) - diffMin * 60));
          return reply.status(429).send({ error: `Recharge Quiz trop fréquente. Réessayez dans ${remainMinutes} min.`, retrySeconds });
        }
      }
      const currentQuiz = Number(player.quizTokens ?? 0);
      const nextQuiz = Math.min(QUIZ_MAX_TOKENS, currentQuiz + QUIZ_AD_REWARD);
      const addedQuiz = Math.max(0, nextQuiz - currentQuiz);
      await (prisma as any).player.update({
        where: { id: player.id },
        data: {
          quizTokens: nextQuiz,
          lastAdQuizAt: NOW,
          ...(addedQuiz > 0 ? { lastTokenEarnedAt: NOW } : {}),
        },
      });
      return reply.send({ ok: true, type: 'quiz', tokens: nextQuiz, max: QUIZ_MAX_TOKENS, added: addedQuiz, adReward: QUIZ_AD_REWARD, cooldownSeconds: AD_COOLDOWN_SECONDS, message: addedQuiz > 0 ? `+${addedQuiz} tokens Quiz ajoutés ✅` : 'Tokens Quiz déjà au maximum ✅' });
    }
  });
}
