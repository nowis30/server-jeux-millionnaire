/**
 * Script de test : Génération de questions avec images
 * Usage: node scripts/test-generate-images.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🎯 Test de génération de questions avec images\n');

  // Tester la route de génération
  try {
    const response = await fetch('http://localhost:3001/api/quiz/trigger-generation-get?secret=generate123', {
      method: 'GET',
    });

    const data = await response.json();
    console.log('✅ Réponse du serveur:', JSON.stringify(data, null, 2));

    // Vérifier les questions générées avec images
    console.log('\n📸 Questions avec images:');
    const questionsWithImages = await prisma.quizQuestion.findMany({
      where: {
        imageUrl: { not: null }
      },
      select: {
        id: true,
        question: true,
        imageUrl: true,
        category: true,
        difficulty: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (questionsWithImages.length === 0) {
      console.log('❌ Aucune question avec image trouvée');
    } else {
      console.log(`✅ ${questionsWithImages.length} questions avec images trouvées:\n`);
      questionsWithImages.forEach((q, i) => {
        console.log(`${i + 1}. [${q.difficulty}/${q.category}]`);
        console.log(`   Question: ${q.question.substring(0, 80)}...`);
        console.log(`   Image: ${q.imageUrl}`);
        console.log('');
      });
    }

    // Statistiques par catégorie
    console.log('\n📊 Statistiques par catégorie:');
    const stats = await prisma.quizQuestion.groupBy({
      by: ['category'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } }
    });

    stats.forEach(stat => {
      console.log(`  ${stat.category}: ${stat._count.id} questions`);
    });

    // Questions récentes
    console.log('\n🆕 5 dernières questions générées:');
    const recent = await prisma.quizQuestion.findMany({
      select: {
        question: true,
        category: true,
        difficulty: true,
        imageUrl: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    recent.forEach((q, i) => {
      const hasImage = q.imageUrl ? '🖼️' : '📝';
      console.log(`  ${i + 1}. ${hasImage} [${q.difficulty}/${q.category}] ${q.question.substring(0, 70)}...`);
    });

  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
