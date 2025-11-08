import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { registerPropertyRoutes } from '../src/routes/properties';
import { prisma } from '../src/prisma';

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  await registerPropertyRoutes(app);
  return app;
}

async function testPurchaseWithFiftyPercent() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const game = await prisma.game.create({ data: { code: `G${suffix}`, status: 'running' } });
  const player = await prisma.player.create({ data: { nickname: `p_${suffix}`, cash: 1_000_000, netWorth: 1_000_000, gameId: game.id, guestId: `guest_${suffix}` } });
  const tpl = await prisma.propertyTemplate.create({ data: { name: `T_${suffix}`, city: 'Testville', imageUrl: 'x', price: 200000, baseRent: 1800, taxes: 4000, insurance: 800, maintenance: 2000 } });

  const app = await build();

  // Envoi d'un pourcentage entier 50 (doit être normalisé à 0.5 et accepté)
  const res = await app.inject({
    method: 'POST',
    url: `/api/games/${game.id}/properties/purchase`,
    payload: {
      playerId: player.id,
      templateId: tpl.id,
      mortgageRate: 0.05,
      downPaymentPercent: 50,
      mortgageYears: 25,
    },
  });

  if (res.statusCode !== 201) throw new Error(`Purchase(50%) status ${res.statusCode} -> ${res.body}`);
  const body = res.json();
  const holdingId = body?.holdingId as string;
  if (!holdingId) throw new Error('holdingId manquant');

  const holding = await prisma.propertyHolding.findUnique({ where: { id: holdingId } });
  if (!holding) throw new Error('Holding introuvable');
  if (Math.round(holding.downPayment) !== 100000) throw new Error(`Mise de fonds incorrecte: ${holding.downPayment}`);
  if (Math.round(holding.initialMortgageDebt) !== 100000) throw new Error(`Dette initiale incorrecte: ${holding.initialMortgageDebt}`);

  console.log('PURCHASE ROUTE TEST (50%): PASS', { gameId: game.id, playerId: player.id, holdingId });
  await app.close();
}

// Exécuter
testPurchaseWithFiftyPercent().then(() => process.exit(0)).catch(async (err) => {
  console.error('PURCHASE ROUTE TEST: FAIL', err);
  process.exit(1);
});
