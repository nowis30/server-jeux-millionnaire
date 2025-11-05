// Script pour nettoyer manuellement les ticks de marché
// Usage: node scripts/cleanup-ticks-manual.js

require('dotenv').config({ path: __dirname + '/.env' });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const gameId = 'cmhj4yjta0000f0isofn3itjn';

async function cleanupTicks() {
  console.log('🧹 Démarrage du nettoyage des ticks...\n');

  try {
    let totalDeleted = 0;
    const symbols = ["SP500", "QQQ", "TSX", "GLD", "TLT"];
    
    console.log('📊 État avant nettoyage:');
    for (const symbol of symbols) {
      const count = await prisma.marketTick.count({ where: { gameId, symbol } });
      console.log(`  ${symbol}: ${count} ticks`);
    }
    
    console.log('\n🗑️  Nettoyage en cours...');
    
    for (const symbol of symbols) {
      // 1. Récupérer tous les ticks triés par date décroissante
      const allTicks = await prisma.marketTick.findMany({
        where: { gameId, symbol },
        orderBy: { at: "desc" },
        select: { id: true, at: true },
      });
      
      if (allTicks.length <= 100) {
        console.log(`  ${symbol}: ${allTicks.length} ticks (pas de nettoyage nécessaire)`);
        continue;
      }
      
      // 2. Garder les 100 derniers (plus récents)
      const keepRecent = allTicks.slice(0, 100).map(t => t.id);
      
      // 3. Pour les anciens (index 100+), garder 1 sur 100
      const oldTicks = allTicks.slice(100);
      const keepSampled = oldTicks
        .filter((_, index) => index % 100 === 0)
        .map(t => t.id);
      
      // 4. Combiner les deux listes
      const keepIds = [...keepRecent, ...keepSampled];
      
      // 5. Supprimer tous les autres
      const result = await prisma.marketTick.deleteMany({
        where: {
          gameId,
          symbol,
          id: { notIn: keepIds },
        },
      });
      
      totalDeleted += result.count;
      console.log(`  ${symbol}: ${allTicks.length} → ${keepIds.length} (${result.count} supprimés)`);
    }
    
    console.log('\n📊 État après nettoyage:');
    for (const symbol of symbols) {
      const count = await prisma.marketTick.count({ where: { gameId, symbol } });
      console.log(`  ${symbol}: ${count} ticks`);
    }

    console.log(`\n✅ Nettoyage terminé! ${totalDeleted} ticks supprimés au total.\n`);

  } catch (error) {
    console.error('\n❌ Erreur:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

cleanupTicks()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
