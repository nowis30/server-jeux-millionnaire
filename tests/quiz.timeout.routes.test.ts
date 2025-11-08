import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/prisma';
import { registerQuizRoutes } from '../src/routes/quiz';

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  await registerQuizRoutes(app);
  return app;
}

async function setupBase() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const game = await prisma.game.create({ data: { code: `G${suffix}`, status: 'running' } });
  const player = await prisma.player.create({ data: { nickname: `p_${suffix}`, cash: 1_000_000, netWorth: 1_000_000, gameId: game.id, guestId: `guest_${suffix}` } });
  return { suffix, game, player };
}

async function createKidsQuestions(count = 2) {
  const qs = [] as Array<{ id: string }>;
  for (let i = 0; i < count; i++) {
    const q = await prisma.quizQuestion.create({
      data: {
        question: `Q enfant ${Math.random().toString(36).slice(2,7)}`,
        optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D',
        correctAnswer: 'A', difficulty: 'easy', category: 'kids',
      }
    });
    qs.push({ id: q.id });
  }
  return qs;
}

async function testTimeoutAutoSkip() {
  const { game, player } = await setupBase();
  const [q1, q2] = await createKidsQuestions(2);

  // Créer une session active avec des skips
  const session = await prisma.quizSession.create({
    data: {
      playerId: player.id,
      gameId: game.id,
      status: 'active',
      currentQuestion: 1,
      currentEarnings: 0,
      securedAmount: 0,
      // @ts-ignore champs défaut en base
      skipsLeft: 2,
    } as any,
  });

  const app = await build();
  const res = await app.inject({
    method: 'POST',
    url: `/api/games/${game.id}/quiz/timeout`,
    headers: { 'x-player-id': player.id },
    payload: { sessionId: session.id, questionId: q1.id },
  });
  if (res.statusCode !== 200) throw new Error(`Timeout autoskip status ${res.statusCode}: ${res.body}`);
  const body = res.json();
  if (!body?.timeout || body?.action !== 'auto-skip') throw new Error('Auto-skip non déclenché');
  if (typeof body?.session?.skipsLeft !== 'number' || body.session.skipsLeft !== 1) throw new Error('skipsLeft non décrémenté');
  if (!body?.question?.id) throw new Error('Question suivante manquante');

  await app.close();
}

async function testTimeoutAutoCashOut() {
  const { game, player } = await setupBase();
  const [q1] = await createKidsQuestions(1);

  // Session sans skip et avec gains courants
  const earnings = 12500;
  const session = await prisma.quizSession.create({
    data: {
      playerId: player.id,
      gameId: game.id,
      status: 'active',
      currentQuestion: 3,
      currentEarnings: earnings,
      securedAmount: 0,
      // @ts-ignore
      skipsLeft: 0,
    } as any,
  });

  const cashBefore = player.cash;

  const app = await build();
  const res = await app.inject({
    method: 'POST',
    url: `/api/games/${game.id}/quiz/timeout`,
    headers: { 'x-player-id': player.id },
    payload: { sessionId: session.id, questionId: q1.id },
  });
  if (res.statusCode !== 200) throw new Error(`Timeout cashout status ${res.statusCode}: ${res.body}`);
  const body = res.json();
  if (!body?.timeout || body?.action !== 'auto-cash-out') throw new Error('Auto cash-out non déclenché');
  if (body?.finalPrize !== earnings) throw new Error('Montant encaissé incorrect');

  // Vérifier mise à jour du joueur et de la session
  const playerAfter = await prisma.player.findUnique({ where: { id: player.id } });
  if (!playerAfter) throw new Error('Player introuvable après cash-out');
  if (Math.round(playerAfter.cash) !== Math.round(cashBefore + earnings)) throw new Error('Cash joueur non crédité');
  const sessionAfter = await prisma.quizSession.findUnique({ where: { id: session.id } });
  if (!sessionAfter || sessionAfter.status !== 'cashed-out') throw new Error('Session non cashed-out');

  await app.close();
}

(async () => {
  try {
    await testTimeoutAutoSkip();
    await testTimeoutAutoCashOut();
    console.log('QUIZ TIMEOUT ROUTES TEST: PASS');
    process.exit(0);
  } catch (err) {
    console.error('QUIZ TIMEOUT ROUTES TEST: FAIL', err);
    process.exit(1);
  }
})();
