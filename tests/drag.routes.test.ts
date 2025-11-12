import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/prisma';
import { registerDragRoutes } from '../src/routes/drag';

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  await registerDragRoutes(app);
  return app;
}

async function setupBase() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const game = await prisma.game.create({ data: { code: `DG${suffix}`, status: 'running' } });
  const player = await prisma.player.create({
    data: {
      nickname: `drag_${suffix}`,
      cash: 1_000_000,
      netWorth: 1_000_000,
      gameId: game.id,
      guestId: `guest_${suffix}`,
      // @ts-ignore drag fields exist in DB after schema update
      dragStage: 1,
    } as any,
  });
  return { suffix, game, player };
}

async function testSessionReturnsDefaults() {
  const { game, player } = await setupBase();
  const app = await build();
  const res = await app.inject({ method: 'GET', url: `/api/games/${game.id}/drag/session`, headers: { 'x-player-id': player.id } });
  if (res.statusCode !== 200) throw new Error(`session status ${res.statusCode}: ${res.body}`);
  const body = res.json();
  if (!body?.player?.id || body.player.id !== player.id) throw new Error('player.id mismatch');
  if (!body?.drag || typeof body.drag.stage !== 'number') throw new Error('drag.stage missing');
  if (body.drag.stage !== 1) throw new Error('expected stage 1 for new player');
  await app.close();
}

async function testWinGrantsRewardAndProgression() {
  const { game, player } = await setupBase();
  const app = await build();

  const before = await prisma.player.findUnique({ where: { id: player.id }, select: { cash: true, netWorth: true, dragStage: true } as any }) as any;
  const payload = { stage: 1, elapsedMs: 6000, win: true, perfectShifts: 4 };
  const res = await app.inject({
    method: 'POST', url: `/api/games/${game.id}/drag/result`,
    headers: { 'x-player-id': player.id }, payload
  });
  if (res.statusCode !== 200) throw new Error(`result status ${res.statusCode}: ${res.body}`);
  const body = res.json();
  if (!body?.ok) throw new Error('ok missing');
  if (body.grantedReward !== 50000) throw new Error(`expected 50000 reward, got ${body.grantedReward}`);

  const after = await prisma.player.findUnique({ where: { id: player.id }, select: { cash: true, netWorth: true, dragStage: true } as any }) as any;
  if (Math.round(after.cash) !== Math.round(before.cash + 50000)) throw new Error('cash not incremented');
  if (after.dragStage !== 2) throw new Error('stage did not progress to 2');
  await app.close();
}

async function testCooldownPreventsImmediateSecondReward() {
  const { game, player } = await setupBase();
  const app = await build();

  // First win
  const r1 = await app.inject({ method: 'POST', url: `/api/games/${game.id}/drag/result`, headers: { 'x-player-id': player.id }, payload: { stage: 1, elapsedMs: 6000, win: true, perfectShifts: 3 } });
  if (r1.statusCode !== 200) throw new Error(`first win failed ${r1.statusCode}`);
  const b1 = r1.json();
  if (b1.grantedReward !== 50000) throw new Error('first reward not granted');

  const cashMid = (await prisma.player.findUnique({ where: { id: player.id }, select: { cash: true } }))?.cash || 0;

  // Immediate second win (cooldown)
  // attendre >1s pour éviter le throttle "runs trop rapprochés"
  await new Promise((r) => setTimeout(r, 1100));
  const r2 = await app.inject({ method: 'POST', url: `/api/games/${game.id}/drag/result`, headers: { 'x-player-id': player.id }, payload: { stage: 2, elapsedMs: 6000, win: true, perfectShifts: 2 } });
  if (r2.statusCode !== 200) throw new Error(`second result status ${r2.statusCode}`);
  const b2 = r2.json();
  if (b2.grantedReward !== 0) throw new Error('cooldown not enforced: reward should be 0');

  const cashAfter = (await prisma.player.findUnique({ where: { id: player.id }, select: { cash: true } }))?.cash || 0;
  if (Math.round(cashAfter) !== Math.round(cashMid)) throw new Error('cash changed despite cooldown');
  await app.close();
}

async function testRejectImpossibleTime() {
  const { game, player } = await setupBase();
  const app = await build();
  const res = await app.inject({ method: 'POST', url: `/api/games/${game.id}/drag/result`, headers: { 'x-player-id': player.id }, payload: { stage: 1, elapsedMs: 1000, win: true, perfectShifts: 8 } });
  if (res.statusCode === 200) throw new Error('expected rejection for impossible time');
  if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
  await app.close();
}

(async () => {
  try {
    await testSessionReturnsDefaults();
    await testWinGrantsRewardAndProgression();
    await testCooldownPreventsImmediateSecondReward();
    await testRejectImpossibleTime();
    console.log('DRAG ROUTES TEST: PASS');
    process.exit(0);
  } catch (err) {
    console.error('DRAG ROUTES TEST: FAIL', err);
    process.exit(1);
  }
})();
