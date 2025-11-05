/**
 * Script pour générer des questions via l'IA OpenAI
 * 
 * Usage: 
 *   OPENAI_API_KEY=sk-xxx node scripts/generate-ai-questions.js
 * 
 * Génère environ 100 questions variées :
 * - 40 faciles
 * - 35 moyennes  
 * - 25 difficiles
 * 
 * Vérifie automatiquement les doublons et mélange l'ordre des réponses
 */

const { generateAndSaveQuestions } = require('../dist/services/aiQuestions');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🤖 Génération de questions avec l\'IA OpenAI\n');

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ ERREUR: Variable OPENAI_API_KEY non définie');
    console.log('\n💡 Usage:');
    console.log('   OPENAI_API_KEY=sk-xxx node scripts/generate-ai-questions.js');
    process.exit(1);
  }

  try {
    // Compter les questions existantes
    const before = {
      easy: await prisma.quizQuestion.count({ where: { difficulty: 'easy' } }),
      medium: await prisma.quizQuestion.count({ where: { difficulty: 'medium' } }),
      hard: await prisma.quizQuestion.count({ where: { difficulty: 'hard' } }),
    };

    console.log('📊 Questions avant génération:');
    console.log(`   Faciles: ${before.easy}`);
    console.log(`   Moyennes: ${before.medium}`);
    console.log(`   Difficiles: ${before.hard}`);
    console.log(`   Total: ${before.easy + before.medium + before.hard}\n`);

    // Générer les questions
    const created = await generateAndSaveQuestions();

    // Compter après
    const after = {
      easy: await prisma.quizQuestion.count({ where: { difficulty: 'easy' } }),
      medium: await prisma.quizQuestion.count({ where: { difficulty: 'medium' } }),
      hard: await prisma.quizQuestion.count({ where: { difficulty: 'hard' } }),
    };

    console.log('\n📊 Questions après génération:');
    console.log(`   Faciles: ${after.easy} (+${after.easy - before.easy})`);
    console.log(`   Moyennes: ${after.medium} (+${after.medium - before.medium})`);
    console.log(`   Difficiles: ${after.hard} (+${after.hard - before.hard})`);
    console.log(`   Total: ${after.easy + after.medium + after.hard} (+${created})`);

    console.log('\n✅ Génération terminée avec succès!');
    console.log('\n💡 Les questions ont des réponses mélangées pour plus de diversité.');
    console.log('💡 Les doublons ont été automatiquement évités.');

  } catch (error) {
    console.error('\n❌ Erreur:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
