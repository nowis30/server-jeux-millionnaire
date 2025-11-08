import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/prisma';
import { registerPariRoutes } from '../src/routes/pari';
import { registerTokenRoutes } from '../src/routes/tokens';
import { registerGameRoutes } from '../src/routes/games';

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  await registerGameRoutes(app);
  await registerPariRoutes(app);
  await registerTokenRoutes(app);
  return app;
}

async function setupPlayer() {
  const suffix = Math.random().toString(36).slice(2,8);
  const game = await prisma.game.create({ data: { code: `TP${suffix}` , status: 'running' } });
  const player = await (prisma as any).player.create({ data: { nickname: `pl_${suffix}`, cash: 1_000_000, netWorth: 1_000_000, game: { connect: { id: game.id } }, guestId: `guest_${suffix}`, pariTokens: 2 } });
  return { game, player };
}

async function testPlayConsumesToken() {
  const { game, player } = await setupPlayer();
  const app = await build();

  // Status initial
  const status1 = await app.inject({ method: 'GET', url: `/api/games/${game.id}/pari/status`, headers: { 'x-player-id': player.id } });
  if (status1.statusCode !== 200) throw new Error('Status initial échoué');
  const sBody = status1.json();
  if (typeof sBody.tokens !== 'number') throw new Error('tokens manquant');

  // Lancer un pari (mise minimale 5000)
  const playRes = await app.inject({ method: 'POST', url: `/api/games/${game.id}/pari/play`, headers: { 'x-player-id': player.id }, payload: { bet: 5000 } });
  if (playRes.statusCode !== 200) throw new Error(`Play échoué ${playRes.statusCode}: ${playRes.body}`);
  const pBody = playRes.json();
  if (typeof pBody.tokensLeft !== 'number') throw new Error('tokensLeft manquant');
  if (pBody.tokensLeft !== (sBody.tokens - 1)) throw new Error('Token non décrémenté');

  await app.close();
}

async function testNoTokenForbidden() {
  const { game, player } = await setupPlayer();
  // Mettre tokens à 0
  await (prisma as any).player.update({ where: { id: player.id }, data: { pariTokens: 0 } });
  const app = await build();
  const res = await app.inject({ method: 'POST', url: `/api/games/${game.id}/pari/play`, headers: { 'x-player-id': player.id }, payload: { bet: 5000 } });
  if (res.statusCode !== 403) throw new Error(`Expected 403 when no tokens, got ${res.statusCode}`);
  await app.close();
}

async function testAdRecharge() {
  const { game, player } = await setupPlayer();
  // Mettre tokens à 0 pour observer recharge
  await (prisma as any).player.update({ where: { id: player.id }, data: { pariTokens: 0 } });
  const app = await build();
  const res = await app.inject({ method: 'POST', url: `/api/games/${game.id}/pari/ad-recharge`, headers: { 'x-player-id': player.id }, payload: { type: 'pari' } });
  if (res.statusCode !== 200) throw new Error(`Recharge pari failed ${res.statusCode}: ${res.body}`);
  const body = res.json();
  if (!body.ok || body.tokens !== 100) throw new Error('Recharge pari incorrecte');
  await app.close();
}

(async () => {
  try {
    await testPlayConsumesToken();
    await testNoTokenForbidden();
    await testAdRecharge();
    console.log('PARI TOKENS ROUTES TEST: PASS');
    process.exit(0);
  } catch (e) {
    console.error('PARI TOKENS ROUTES TEST: FAIL', e);
    process.exit(1);
  }
})();
