// Script pour redémarrer la partie directement via la base de données
// Usage: node scripts/restart-game.js

require('dotenv').config({ path: __dirname + '/.env' });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const gameId = 'cmhj4yjta0000f0isofn3itjn';

async function restartGame() {
  console.log('🔄 Démarrage du redémarrage de la partie...\n');

  try {
    console.log('📊 État avant redémarrage:');
    const before = {
      players: await prisma.player.count({ where: { gameId } }),
      marketTicks: await prisma.marketTick.count({ where: { gameId } }),
      marketHoldings: await prisma.marketHolding.count({ where: { gameId } }),
      propertyHoldings: await prisma.propertyHolding.count({ where: { gameId } }),
      dividendLogs: await prisma.dividendLog.count({ where: { gameId } }),
      listings: await prisma.listing.count({ where: { gameId } }),
    };
    console.log(before);

    console.log('\n🗑️  Suppression des données...');
    
    // Supprimer dans l'ordre pour éviter les violations de clés étrangères
    console.log('  - Listings...');
    const r1 = await prisma.listing.deleteMany({ where: { gameId } });
    console.log(`    ✓ ${r1.count} supprimés`);

    console.log('  - DividendLogs...');
    const r2 = await prisma.dividendLog.deleteMany({ where: { gameId } });
    console.log(`    ✓ ${r2.count} supprimés`);

    console.log('  - RepairEvents...');
    const r3 = await prisma.repairEvent.deleteMany({ 
      where: { holding: { gameId } } 
    });
    console.log(`    ✓ ${r3.count} supprimés`);

    console.log('  - RefinanceLogs...');
    const r4 = await prisma.refinanceLog.deleteMany({ 
      where: { holding: { gameId } } 
    });
    console.log(`    ✓ ${r4.count} supprimés`);

    console.log('  - PropertyHoldings...');
    const r5 = await prisma.propertyHolding.deleteMany({ where: { gameId } });
    console.log(`    ✓ ${r5.count} supprimés`);

    console.log('  - MarketHoldings...');
    const r6 = await prisma.marketHolding.deleteMany({ where: { gameId } });
    console.log(`    ✓ ${r6.count} supprimés`);

    console.log('  - MarketTicks...');
    const r7 = await prisma.marketTick.deleteMany({ where: { gameId } });
    console.log(`    ✓ ${r7.count} supprimés`);

    console.log('  - Players...');
    const r8 = await prisma.player.deleteMany({ where: { gameId } });
    console.log(`    ✓ ${r8.count} supprimés`);

    console.log('\n♻️  Mise à jour du statut de la partie...');
    await prisma.game.update({
      where: { id: gameId },
      data: { 
        status: 'running', 
        startedAt: new Date() 
      }
    });
    console.log('    ✓ Partie réinitialisée');

    console.log('\n📊 État après redémarrage:');
    const after = {
      players: await prisma.player.count({ where: { gameId } }),
      marketTicks: await prisma.marketTick.count({ where: { gameId } }),
      marketHoldings: await prisma.marketHolding.count({ where: { gameId } }),
      propertyHoldings: await prisma.propertyHolding.count({ where: { gameId } }),
      dividendLogs: await prisma.dividendLog.count({ where: { gameId } }),
      listings: await prisma.listing.count({ where: { gameId } }),
    };
    console.log(after);

    console.log('\n✅ Redémarrage terminé avec succès !');
    console.log('Tu peux maintenant rejoindre la partie sur le site.\n');

  } catch (error) {
    console.error('\n❌ Erreur:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

restartGame()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
