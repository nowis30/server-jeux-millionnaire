import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireUserOrGuest } from "./auth";
import { updatePariTokens, getPariSecondsUntilNext, PARI_MAX_TOKENS, PARI_AD_REWARD } from "../services/pariTokens";
import { updatePlayerTokens, getTimeUntilNextToken, QUIZ_MAX_TOKENS, QUIZ_AD_REWARD } from "../services/quizTokens";

const AD_COOLDOWN_MINUTES = 30;
const AD_COOLDOWN_SECONDS = AD_COOLDOWN_MINUTES * 60;

function computeCooldownSeconds(last: Date | string | null | undefined, minutes: number): number {
  if (!last) return 0;
  const lastDate = typeof last === "string" ? new Date(last) : last;
  const elapsedMs = Date.now() - lastDate.getTime();
  const windowMs = minutes * 60 * 1000;
  if (elapsedMs >= windowMs) return 0;
  return Math.max(0, Math.ceil((windowMs - elapsedMs) / 1000));
}

export async function registerTokenRoutes(app: FastifyInstance) {
  // GET /api/games/:gameId/tokens - Statut combiné Quiz/Pari
  app.get('/api/games/:gameId/tokens', { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
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

    const [quizTokens, quizNext, pariTokens, pariNext] = await Promise.all([
      updatePlayerTokens(player.id),
      getTimeUntilNextToken(player.id),
      updatePariTokens(player.id),
      getPariSecondsUntilNext(player.id),
    ]);

    const adPariSeconds = computeCooldownSeconds(player.lastAdPariAt, AD_COOLDOWN_MINUTES);
    const adQuizSeconds = computeCooldownSeconds(player.lastAdQuizAt, AD_COOLDOWN_MINUTES);

    return reply.send({
      quiz: {
        tokens: quizTokens,
        max: QUIZ_MAX_TOKENS,
        secondsUntilNext: quizNext,
        adCooldownSeconds: adQuizSeconds,
        adReward: QUIZ_AD_REWARD,
      },
      pari: {
        tokens: pariTokens,
        max: PARI_MAX_TOKENS,
        secondsUntilNext: pariNext,
        adCooldownSeconds: adPariSeconds,
        adReward: PARI_AD_REWARD,
      },
    });
  });

  // POST /api/games/:gameId/tokens/ads - Recharge via annonce
  app.post('/api/games/:gameId/tokens/ads', { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
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
      return reply.send({
        ok: true,
        type: 'pari',
        tokens: next,
        max: PARI_MAX_TOKENS,
        added,
        adReward: PARI_AD_REWARD,
        cooldownSeconds: AD_COOLDOWN_SECONDS,
      });
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
      return reply.send({
        ok: true,
        type: 'quiz',
        tokens: nextQuiz,
        max: QUIZ_MAX_TOKENS,
        added: addedQuiz,
        adReward: QUIZ_AD_REWARD,
        cooldownSeconds: AD_COOLDOWN_SECONDS,
      });
    }
  });
}
