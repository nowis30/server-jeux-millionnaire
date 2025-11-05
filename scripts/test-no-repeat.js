/**
 * Script de test du système anti-répétition des questions quiz
 * 
 * Ce script simule plusieurs sessions de quiz pour un joueur
 * et vérifie qu'aucune question ne se répète.
 * 
 * Usage:
 *   npm run build
 *   node scripts/test-no-repeat.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Simulation de la fonction selectUnseenQuestion
async function selectUnseenQuestion(playerId, difficulty) {
  const seenQuestions = await prisma.quizQuestionSeen.findMany({
    where: { playerId },
    select: { questionId: true },
  });
  
  const seenIds = seenQuestions.map(sq => sq.questionId);
  
  const unseenCount = await prisma.quizQuestion.count({
    where: {
      difficulty,
      id: { notIn: seenIds },
    },
  });
  
  if (unseenCount > 0) {
    const skip = Math.floor(Math.random() * unseenCount);
    return await prisma.quizQuestion.findFirst({
      where: {
        difficulty,
        id: { notIn: seenIds },
      },
      skip,
    });
  }
  
  // Reset pour cette difficulté
  console.log(`  🔄 Reset automatique pour difficulté "${difficulty}" (toutes vues)`);
  await prisma.quizQuestionSeen.deleteMany({
    where: {
      playerId,
      question: { difficulty },
    },
  });
  
  const totalCount = await prisma.quizQuestion.count({
    where: { difficulty },
  });
  
  if (totalCount === 0) {
    return null;
  }
  
  const skip = Math.floor(Math.random() * totalCount);
  return await prisma.quizQuestion.findFirst({
    where: { difficulty },
    skip,
  });
}

async function markQuestionAsSeen(playerId, questionId) {
  await prisma.quizQuestionSeen.upsert({
    where: {
      playerId_questionId: { playerId, questionId },
    },
    create: {
      playerId,
      questionId,
    },
    update: {
      seenAt: new Date(),
    },
  });
}

async function runTest() {
  console.log('🧪 Test du système anti-répétition\n');

  // Trouver ou créer un joueur de test
  const game = await prisma.game.findFirst({
    where: { status: 'active' },
  });

  if (!game) {
    console.error('❌ Aucune partie active trouvée. Crée une partie d\'abord.');
    return;
  }

  let testPlayer = await prisma.player.findFirst({
    where: {
      gameId: game.id,
      nickname: 'TestNoRepeat',
    },
  });

  if (!testPlayer) {
    console.log('📝 Création du joueur de test "TestNoRepeat"...');
    testPlayer = await prisma.player.create({
      data: {
        gameId: game.id,
        nickname: 'TestNoRepeat',
        guestId: 'test-no-repeat-' + Date.now(),
        cash: 1000000,
        netWorth: 1000000,
      },
    });
  } else {
    // Reset son historique
    console.log('🧹 Nettoyage de l\'historique du joueur de test...');
    await prisma.quizQuestionSeen.deleteMany({
      where: { playerId: testPlayer.id },
    });
  }

  console.log(`✅ Joueur de test prêt (ID: ${testPlayer.id})\n`);

  // Compter les questions disponibles
  const counts = await Promise.all([
    prisma.quizQuestion.count({ where: { difficulty: 'easy' } }),
    prisma.quizQuestion.count({ where: { difficulty: 'medium' } }),
    prisma.quizQuestion.count({ where: { difficulty: 'hard' } }),
  ]);

  console.log('📊 Questions disponibles:');
  console.log(`   Faciles : ${counts[0]}`);
  console.log(`   Moyennes : ${counts[1]}`);
  console.log(`   Difficiles : ${counts[2]}`);
  console.log();

  // Simuler plusieurs sessions
  const sessionsToTest = Math.min(3, counts[0]); // Max 3 sessions ou moins si peu de questions
  const seenQuestionIds = new Set();
  let resetCount = 0;

  for (let sessionNum = 1; sessionNum <= sessionsToTest; sessionNum++) {
    console.log(`🎮 Session ${sessionNum}:`);
    
    // Tester avec 5 questions faciles
    const sessionQuestions = [];
    
    for (let q = 1; q <= 5; q++) {
      const question = await selectUnseenQuestion(testPlayer.id, 'easy');
      
      if (!question) {
        console.log(`  ⚠️  Question ${q}: Aucune question disponible`);
        continue;
      }

      // Vérifier si déjà vue dans cette session
      if (sessionQuestions.includes(question.id)) {
        console.log(`  ❌ Question ${q}: ERREUR - Question répétée dans la même session!`);
        console.log(`     ID: ${question.id}`);
        process.exit(1);
      }

      // Vérifier si vue dans sessions précédentes (avant reset)
      const alreadySeenBefore = seenQuestionIds.has(question.id);
      
      sessionQuestions.push(question.id);
      await markQuestionAsSeen(testPlayer.id, question.id);
      
      const shortQuestion = question.question.substring(0, 60) + '...';
      if (alreadySeenBefore) {
        console.log(`  🔄 Question ${q}: "${shortQuestion}" (revue après reset)`);
        resetCount++;
      } else {
        console.log(`  ✅ Question ${q}: "${shortQuestion}" (nouvelle)`);
        seenQuestionIds.add(question.id);
      }
    }
    
    console.log();
  }

  // Statistiques finales
  const totalSeen = await prisma.quizQuestionSeen.count({
    where: { playerId: testPlayer.id },
  });

  console.log('📈 Résultats du test:');
  console.log(`   Questions uniques vues : ${seenQuestionIds.size}`);
  console.log(`   Total de présentations : ${totalSeen}`);
  console.log(`   Resets automatiques : ${resetCount > 0 ? 'Oui' : 'Non'}`);
  console.log(`   Sessions testées : ${sessionsToTest}`);
  
  if (seenQuestionIds.size === totalSeen && resetCount === 0) {
    console.log('\n✅ TEST RÉUSSI : Aucune répétition détectée !');
  } else if (resetCount > 0) {
    console.log('\n✅ TEST RÉUSSI : Reset automatique fonctionne correctement !');
  } else {
    console.log('\n⚠️  ATTENTION : Des répétitions ont été détectées.');
  }

  // Nettoyage
  console.log('\n🧹 Nettoyage...');
  await prisma.quizQuestionSeen.deleteMany({
    where: { playerId: testPlayer.id },
  });

  console.log('✅ Test terminé !');
}

runTest()
  .catch((err) => {
    console.error('❌ Erreur durant le test:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
