/**
 * Script pour vérifier si le schéma de la base de données est à jour
 * Usage: node scripts/check-schema.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkSchema() {
  console.log('🔍 Vérification du schéma de la base de données...\n');

  try {
    // Vérifier que la table QuizQuestion existe
    const questionCount = await prisma.quizQuestion.count();
    console.log(`✅ Table QuizQuestion: ${questionCount} questions`);

    // Vérifier que la table QuizQuestionSeen existe
    const seenCount = await prisma.quizQuestionSeen.count();
    console.log(`✅ Table QuizQuestionSeen: ${seenCount} entrées`);

    // Vérifier que les champs tokens existent sur Player
    const player = await prisma.player.findFirst({
      select: {
        id: true,
        nickname: true,
        quizTokens: true,
        lastTokenEarnedAt: true,
      },
    });

    if (player) {
      console.log(`✅ Champs tokens sur Player:`);
      console.log(`   - quizTokens: ${player.quizTokens}`);
      console.log(`   - lastTokenEarnedAt: ${player.lastTokenEarnedAt}`);
    } else {
      console.log(`⚠️  Aucun joueur trouvé, mais les champs existent`);
    }

    console.log('\n✅ Schéma complet et à jour!');
  } catch (err) {
    console.error('\n❌ Erreur de schéma:', err.message);
    console.error('\n💡 Solutions:');
    console.log('   1. Exécutez: npx prisma migrate deploy');
    console.log('   2. Ou: npx prisma db push');
  } finally {
    await prisma.$disconnect();
  }
}

checkSchema();
