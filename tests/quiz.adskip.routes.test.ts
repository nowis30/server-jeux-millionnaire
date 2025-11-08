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
  const game = await prisma.game.create({ data: { code: `QAS_${suffix}`, status: 'running' } });
  const player = await prisma.player.create({ data: { nickname: `p_${suffix}`, cash: 1_000_000, netWorth: 1_000_000, gameId: game.id, guestId: `guest_${suffix}` } });
  return { suffix, game, player };
}

async function createKidsQuestions(count = 1) {
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

async function testAdSkipGivesOne() {
  const { game, player } = await setupBase();
  await createKidsQuestions(1);
  const session = await prisma.quizSession.create({ data: { playerId: player.id, gameId: game.id, status: 'active', currentQuestion: 1, currentEarnings: 0, securedAmount: 0, skipsLeft: 0 } as any });
  const app = await build();
  const res = await app.inject({ method: 'POST', url: `/api/games/${game.id}/quiz/ad-skip`, headers: { 'x-player-id': player.id }, payload: { sessionId: session.id } });
  if (res.statusCode !== 200) throw new Error(`ad-skip failed ${res.statusCode}: ${res.body}`);
  const body = res.json();
  if (!body?.ok || body?.skipsLeft !== 1) throw new Error('ad-skip n\'a pas rendu 1 skip');
  await app.close();
}

(async () => {
  try {
    await testAdSkipGivesOne();
    console.log('QUIZ AD-SKIP ROUTE TEST: PASS');
    process.exit(0);
  } catch (e) {
    console.error('QUIZ AD-SKIP ROUTE TEST: FAIL', e);
    process.exit(1);
  }
})();
