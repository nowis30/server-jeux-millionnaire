import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('[reset:games] Début — suppression des parties et entités liées');
  // Supprimer dans un ordre sûr pour respecter les FK
  const listings = await prisma.listing.deleteMany({});
  const repairs = await prisma.repairEvent.deleteMany({});
  const refis = await prisma.refinanceLog.deleteMany({});
  const holdings = await prisma.propertyHolding.deleteMany({});
  const ticks = await prisma.marketTick.deleteMany({});
  const mktHoldings = await prisma.marketHolding.deleteMany({});
  const players = await prisma.player.deleteMany({});
  const games = await prisma.game.deleteMany({});

  console.log('[reset:games] Résumé suppressions:', {
    listings: listings.count,
    repairs: repairs.count,
    refinanceLogs: refis.count,
    propertyHoldings: holdings.count,
    marketTicks: ticks.count,
    marketHoldings: mktHoldings.count,
    players: players.count,
    games: games.count,
  });

  console.log('[reset:games] Terminé.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
