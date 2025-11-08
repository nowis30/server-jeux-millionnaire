import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/prisma';
import { registerPropertyRoutes } from '../src/routes/properties';
import { ensureExactTypeCounts } from '../src/services/seeder';

// Test ciblé: vérifier que ensureExactTypeCounts crée les tours résidentielle (100 log.)
// jusqu'à la cible demandée, en respectant la logique de prix et champs de base.

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  await registerPropertyRoutes(app); // pas strictement nécessaire mais cohérent avec autres tests
  return app;
}

async function testEnsureExactCounts100Units() {
  const before = await prisma.propertyTemplate.count({ where: { units: 100 } });
  // Cible: au moins 3 tours 100 unités (si aucune présente)
  const target = before >= 3 ? before + 2 : 3; // Forcer création si <3
  const res = await ensureExactTypeCounts({ 100: target }, { priceMultiplier: 1 });
  const after = await prisma.propertyTemplate.count({ where: { units: 100 } });

  if (!res['Tour résidentielle (100 log.)(100)']) {
    throw new Error('Résultat ensureExactTypeCounts absent pour 100 unités');
  }
  if (after < target) {
    throw new Error(`Nombre insuffisant après création: ${after} < ${target}`);
  }

  // Vérifier caractéristiques de base sur un template 100 unités
  const sample = (await prisma.propertyTemplate.findMany({ where: { units: 100 }, orderBy: { id: 'desc' }, take: 1 }))[0];
  if (!sample) throw new Error('Aucun template 100 unités trouvé');
  const rent = Number(sample.baseRent || 0);
  if (rent < 800 || rent > 2000) {
    throw new Error(`Loyer unitaire hors plage plausible: ${rent}`);
  }
  const price = Number(sample.price || 0);
  const annualGross = rent * 100 * 12;
  // GRM attendu ~13-15 => price approximativement entre 13x et 15x revenus annuels
  const grm = annualGross > 0 ? price / annualGross : 0;
  if (grm < 12.5 || grm > 15.5) {
    throw new Error(`GRM hors fourchette attendue (≈13-15): ${grm.toFixed(2)}`);
  }
  // Attendu >= 60? (seed actuel met 80 lors de quotas; ensureExactTypeCounts applique now floors >=80)
  if (Number(sample.floors || 0) < 60) {
    throw new Error(`Nombre d'étages trop bas pour 100 unités (attendu >=60): ${sample.floors}`);
  }

  console.log('PROPERTY EXACT COUNT 100 TEST: PASS', { before, after, target, grm: grm.toFixed(2) });
}

build()
  .then(() => testEnsureExactCounts100Units())
  .then(() => process.exit(0))
  .catch(err => { console.error('PROPERTY EXACT COUNT 100 TEST: FAIL', err); process.exit(1); });
