/**
 * Script de test rapide de l'API Quiz
 * 
 * Usage: npm run build && node scripts/test-quiz-api.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testQuizAPI() {
  console.log('🧪 Test de l\'API Quiz\n');

  try {
    // 1. Trouver une partie active ou running
    let game = await prisma.game.findFirst({
      where: { status: 'active' },
    });

    if (!game) {
      // Essayer avec 'running'
      game = await prisma.game.findFirst({
        where: { status: 'running' },
      });
    }

    if (!game) {
      console.log('❌ Aucune partie active ou running.');
      console.log('💡 Statuts des parties :');
      const allGames = await prisma.game.findMany({
        select: { code: true, status: true },
      });
      allGames.forEach(g => console.log(`   ${g.code}: ${g.status}`));
      return;
    }

    console.log(`✅ Partie trouvée: ${game.code} (ID: ${game.id}, Status: ${game.status})`);

    // 2. Trouver ou créer un joueur
    let player = await prisma.player.findFirst({
      where: { gameId: game.id },
    });

    if (!player) {
      console.log('❌ Aucun joueur dans la partie.');
      console.log('\n💡 Pour créer un joueur :');
      console.log('   1. Ouvrez http://localhost:3000');
      console.log(`   2. Rejoignez la partie avec le code: ${game.code}`);
      console.log('   3. Entrez un pseudo et rejoignez');
      console.log('   4. Relancez ce script\n');
      return;
    }

    console.log(`✅ Joueur trouvé: ${player.nickname}`);
    console.log(`   Tokens: ${player.quizTokens}`);
    console.log(`   Dernier token: ${player.lastTokenEarnedAt.toLocaleString()}`);

    // 3. Vérifier les questions
    const questionCounts = {
      easy: await prisma.quizQuestion.count({ where: { difficulty: 'easy' } }),
      medium: await prisma.quizQuestion.count({ where: { difficulty: 'medium' } }),
      hard: await prisma.quizQuestion.count({ where: { difficulty: 'hard' } }),
    };

    console.log('\n📊 Questions disponibles:');
    console.log(`   Faciles: ${questionCounts.easy}`);
    console.log(`   Moyennes: ${questionCounts.medium}`);
    console.log(`   Difficiles: ${questionCounts.hard}`);
    console.log(`   Total: ${questionCounts.easy + questionCounts.medium + questionCounts.hard}`);

    if (questionCounts.easy === 0) {
      console.log('\n⚠️  ATTENTION: Aucune question facile!');
      console.log('   Exécutez: node scripts/seed-quiz.js');
    }

    // 4. Vérifier sessions actives
    const activeSessions = await prisma.quizSession.findMany({
      where: {
        gameId: game.id,
        status: 'active',
      },
      include: {
        player: {
          select: { nickname: true },
        },
      },
    });

    if (activeSessions.length > 0) {
      console.log('\n🎮 Sessions actives:');
      activeSessions.forEach(s => {
        console.log(`   ${s.player.nickname}: Question ${s.currentQuestion}, Gains: $${s.currentEarnings}`);
      });
    } else {
      console.log('\n✅ Aucune session active');
    }

    // 5. Calculer le temps jusqu'au prochain token
    const now = new Date();
    const timeSinceLastToken = now.getTime() - player.lastTokenEarnedAt.getTime();
    const oneHour = 60 * 60 * 1000;
    
    if (timeSinceLastToken >= oneHour) {
      const tokensToGain = Math.floor(timeSinceLastToken / oneHour);
      console.log(`\n🎁 Le joueur devrait gagner ${tokensToGain} token(s) au prochain update`);
    } else {
      const timeUntilNext = oneHour - timeSinceLastToken;
      const minutes = Math.floor(timeUntilNext / 60000);
      const seconds = Math.floor((timeUntilNext % 60000) / 1000);
      console.log(`\n⏱️  Prochain token dans: ${minutes}m ${seconds}s`);
    }

    // 6. Test URL
    console.log('\n📡 URL de test:');
    console.log(`   http://localhost:3001/api/games/${game.id}/quiz/status`);
    console.log('\n💡 Testez avec:');
    console.log(`   curl http://localhost:3001/api/games/${game.id}/quiz/status --cookie "HM_GUEST_ID=${player.guestId}"`);

    console.log('\n✅ Test API terminé!');
    
  } catch (err) {
    console.error('❌ Erreur:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

testQuizAPI();
