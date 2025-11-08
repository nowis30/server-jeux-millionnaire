import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/prisma';
import { registerGameRoutes } from '../src/routes/games';
import { registerPropertyRoutes } from '../src/routes/properties';
import { registerAuthRoutes } from '../src/routes/auth';
import { hourlyTick } from '../src/services/simulation';

// Ce test vérifie que les champs cumulés (loyers, intérêts, taxes, assurance, entretien, cashflow net)
// progressent après plusieurs ticks hebdomadaires via l'endpoint d'avance temporelle.

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  // Plugins nécessaires pour auth (cookies)
  await app.register(require('@fastify/cookie'));
  await registerAuthRoutes(app);
  await registerGameRoutes(app);
  await registerPropertyRoutes(app);
  return app;
}

async function main() {
  const app = await build();

  // Créer le jeu global (appel route /api/games qui crée la partie GLOBAL si absente)
  const gamesResp = await app.inject({ method: 'GET', url: '/api/games' });
  if (gamesResp.statusCode !== 200) throw new Error('Liste jeux échouée');
  const gamesBody = gamesResp.json() as { games: Array<{ id: string; code: string }> };
  const gameId = gamesBody.games[0]?.id;
  if (!gameId) throw new Error('GameId introuvable');

  // Auth inutile pour ce test: on appelle directement le moteur de simulation (hourlyTick)

  // Créer un joueur (player) dans la partie directement via Prisma pour simplifier
  const player = await prisma.player.create({ data: { nickname: 'tester_immo', cash: 1_000_000, netWorth: 1_000_000, gameId, guestId: 'guest-immo' } });

  // Créer un template et un holding immobilier initial
  const tpl = await prisma.propertyTemplate.create({ data: { name: 'Test Immeuble', city: 'VilleX', imageUrl: 'x', price: 400000, baseRent: 3000, taxes: 8000, insurance: 1500, maintenance: 5000 } });
  // Préparer une dette hypothécaire avec paiement hebdo > intérêts pour amortir
  const mortgageDebt = 300000; // principal initial
  const mortgageRate = 0.05; // annuel
  const weeklyRate = mortgageRate / 52;
  // Paiement hebdo = intérêt + 200$ de principal pour assurer décrément
  const weeklyPayment = mortgageDebt * weeklyRate + 200;
  const holding = await prisma.propertyHolding.create({
    data: {
      playerId: player.id,
      gameId,
      templateId: tpl.id,
      purchasePrice: tpl.price,
      currentValue: tpl.price,
      currentRent: tpl.baseRent,
      mortgageRate,
      mortgageDebt,
      weeklyPayment,
    }
  });

  // Avancer 4 semaines via le moteur de simulation directement
  for (let i = 0; i < 4; i++) {
    await hourlyTick(gameId);
  }

  // Relire le holding
  const updated = await prisma.propertyHolding.findUnique({ where: { id: holding.id } });
  if (!updated) throw new Error('Holding non trouvé après avance');

  const weeks = 4;
  // Vérifications de base
  if (Math.round(updated.accumulatedRent) !== Math.round(holding.currentRent * weeks)) {
    throw new Error(`Loyers cumulés incorrects: attendu ~${holding.currentRent * weeks}, obtenu ${updated.accumulatedRent}`);
  }
  if (updated.accumulatedInterestPaid <= 0) throw new Error('Intérêts payés devraient être > 0');
  if (updated.accumulatedTaxesPaid <= 0) throw new Error('Taxes cumulées devraient être > 0');
  if (updated.accumulatedInsurancePaid <= 0) throw new Error('Assurance cumulée devrait être > 0');
  if (updated.accumulatedMaintenancePaid <= 0) throw new Error('Entretien cumulé devrait être > 0');
  if (Math.abs(updated.accumulatedNetCashflow) < 1) throw new Error('Cashflow net cumulé devrait être non nul');

  console.log('IMMOBILIER CUMUL ROUTES TEST: PASS', {
    rent: updated.accumulatedRent,
    interest: updated.accumulatedInterestPaid,
    taxes: updated.accumulatedTaxesPaid,
    insurance: updated.accumulatedInsurancePaid,
    maintenance: updated.accumulatedMaintenancePaid,
    netCashflow: updated.accumulatedNetCashflow,
  });
  await app.close();
}

main().then(() => process.exit(0)).catch(err => { console.error('IMMOBILIER CUMUL ROUTES TEST: FAIL', err); process.exit(1); });
