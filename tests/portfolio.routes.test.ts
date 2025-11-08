import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { registerPropertyRoutes } from '../src/routes/properties';
import { prisma } from '../src/prisma';

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Attacher prisma sur server comme dans index
  (app as any).prisma = prisma;
  await registerPropertyRoutes(app);
  return app;
}

async function testPortfolioAndRepay() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const game = await prisma.game.create({ data: { code: `G${suffix}`, status: 'running' } });
  const player = await prisma.player.create({ data: { nickname: `p_${suffix}`, cash: 1_000_000, netWorth: 1_000_000, gameId: game.id, guestId: `guest_${suffix}` } });

  // Templates
  const tpl = await prisma.propertyTemplate.create({ data: { name: `T1_${suffix}`, city: 'Testville', imageUrl: 'x', price: 400000, baseRent: 3000, taxes: 8000, insurance: 1500, maintenance: 5000 } });
  const tpl2 = await prisma.propertyTemplate.create({ data: { name: `T2_${suffix}`, city: 'Testville', imageUrl: 'x', price: 200000, baseRent: 1800, taxes: 4000, insurance: 800, maintenance: 2000 } });

  // Holdings
  const h1 = await prisma.propertyHolding.create({ data: { playerId: player.id, gameId: game.id, templateId: tpl.id, purchasePrice: tpl.price, currentValue: tpl.price, currentRent: tpl.baseRent, mortgageRate: 0.05, mortgageDebt: 250000, weeklyPayment: 1200 } });
  const h2 = await prisma.propertyHolding.create({ data: { playerId: player.id, gameId: game.id, templateId: tpl2.id, purchasePrice: tpl2.price, currentValue: tpl2.price, currentRent: tpl2.baseRent, mortgageRate: 0.05, mortgageDebt: 120000, weeklyPayment: 700 } });

  const app = await build();

  // Portfolio endpoint
  const res = await app.inject({ method: 'GET', url: `/api/games/${game.id}/players/${player.id}/portfolio` });
  if (res.statusCode !== 200) throw new Error(`Portfolio status ${res.statusCode}`);
  const data = res.json();
  const totalValue = data?.totals?.totalValue;
  if (Math.round(totalValue) < 599999) throw new Error('Total value agrégé incorrect');

  // Repay partial
  const repayAmount = 50_000;
  const repayRes = await app.inject({ method: 'POST', url: `/api/games/${game.id}/properties/${h1.id}/repay`, payload: { amount: repayAmount } });
  if (repayRes.statusCode !== 200) throw new Error(`Repay status ${repayRes.statusCode}`);
  const repayJson = repayRes.json();
  if (repayJson.applied !== repayAmount) throw new Error('Montant remboursé incorrect');

  // Vérifier dette réduite
  const after = await prisma.propertyHolding.findUnique({ where: { id: h1.id } });
  if (!after) throw new Error('Holding manquant après repay');
  if (Math.round(after.mortgageDebt) !== 200000) throw new Error('Réduction dette non appliquée');

  // Repay excess (plus que dette restante) -> appliqué max
  const repayAllRes = await app.inject({ method: 'POST', url: `/api/games/${game.id}/properties/${h1.id}/repay`, payload: { amount: 500000 } });
  if (repayAllRes.statusCode !== 200) throw new Error(`Repay total status ${repayAllRes.statusCode}`);
  const repayAllJson = repayAllRes.json();
  if (Math.round(repayAllJson.newDebt) !== 0) throw new Error('Dette devrait être soldée');

  console.log('PORTFOLIO ROUTES TEST: PASS', { gameId: game.id, playerId: player.id });
  await app.close();
}

testPortfolioAndRepay().then(() => process.exit(0)).catch(async (err) => {
  console.error('PORTFOLIO ROUTES TEST: FAIL', err);
  process.exit(1);
});