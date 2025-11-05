// Script pour réinitialiser les questions vues d'un joueur
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('🔄 Réinitialisation des questions vues...\n');
    
    // Option 1: Réinitialiser TOUT (tous les joueurs)
    // const deleted = await prisma.quizQuestionSeen.deleteMany({});
    // console.log(`✅ ${deleted.count} entrées supprimées pour tous les joueurs\n`);
    
    // Option 2: Réinitialiser par difficulté (garder historique pour autres difficultés)
    const [deletedEasy, deletedMedium, deletedHard] = await Promise.all([
      prisma.quizQuestionSeen.deleteMany({
        where: { question: { difficulty: 'easy' } }
      }),
      prisma.quizQuestionSeen.deleteMany({
        where: { question: { difficulty: 'medium' } }
      }),
      prisma.quizQuestionSeen.deleteMany({
        where: { question: { difficulty: 'hard' } }
      })
    ]);
    
    console.log('✅ Réinitialisation par difficulté:');
    console.log(`   Facile: ${deletedEasy.count} entrées supprimées`);
    console.log(`   Moyen: ${deletedMedium.count} entrées supprimées`);
    console.log(`   Difficile: ${deletedHard.count} entrées supprimées\n`);
    
    console.log('✅ Les joueurs peuvent maintenant revoir toutes les questions!\n');
    
    await prisma.$disconnect();
  } catch (err) {
    console.error('❌ Erreur:', err);
    await prisma.$disconnect();
    process.exit(1);
  }
})();
