/**
 * Script pour synchroniser les questions depuis le serveur Render vers la base locale
 */

const { PrismaClient } = require('@prisma/client');
const https = require('https');

const prisma = new PrismaClient();

const RENDER_API_URL = 'https://heritier-millionnaire.onrender.com/api/quiz/export-questions';

async function fetchQuestionsFromRender() {
  return new Promise((resolve, reject) => {
    console.log('📥 Récupération des questions depuis Render...');
    
    https.get(RENDER_API_URL, (res) => {
      let data = '';
      
      if (res.statusCode === 404) {
        reject(new Error('❌ Endpoint non trouvé (404). Render est peut-être en train de déployer.\n   Réessaye dans 2-3 minutes avec: node scripts/sync-questions-from-render.js'));
        return;
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`Erreur HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (err) {
          reject(new Error('Erreur de parsing JSON: ' + err.message + '\nRéponse reçue: ' + data.substring(0, 200)));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  try {
    // Récupérer les questions depuis Render
    const response = await fetchQuestionsFromRender();
    const questions = response.questions || [];
    
    console.log(`✓ ${questions.length} questions récupérées depuis Render`);
    
    if (questions.length === 0) {
      console.log('⚠️  Aucune question à importer');
      return;
    }
    
    // Supprimer les anciennes questions locales
    console.log('\n🗑️  Suppression des anciennes questions locales...');
    await prisma.quizQuestion.deleteMany({});
    console.log('✓ Anciennes questions supprimées');
    
    // Importer les nouvelles questions par lots de 100
    console.log('\n📥 Import des questions...');
    const batchSize = 100;
    let imported = 0;
    
    for (let i = 0; i < questions.length; i += batchSize) {
      const batch = questions.slice(i, i + batchSize);
      
      await prisma.quizQuestion.createMany({
        data: batch.map(q => ({
          question: q.question,
          optionA: q.optionA,
          optionB: q.optionB,
          optionC: q.optionC,
          optionD: q.optionD,
          correctAnswer: q.correctAnswer,
          difficulty: q.difficulty,
          category: q.category,
          imageUrl: q.imageUrl || null,
        })),
        skipDuplicates: true,
      });
      
      imported += batch.length;
      process.stdout.write(`\r   Importées: ${imported}/${questions.length}`);
    }
    
    console.log('\n\n✅ Import terminé!');
    
    // Statistiques finales
    const total = await prisma.quizQuestion.count();
    const byDifficulty = await prisma.quizQuestion.groupBy({
      by: ['difficulty'],
      _count: true,
    });
    const byCategory = await prisma.quizQuestion.groupBy({
      by: ['category'],
      _count: true,
    });
    
    console.log('\n📊 Statistiques:');
    console.log(`   Total: ${total} questions`);
    console.log('\n   Par difficulté:');
    byDifficulty.forEach(d => {
      console.log(`      ${d.difficulty}: ${d._count}`);
    });
    console.log('\n   Par catégorie:');
    byCategory.forEach(c => {
      console.log(`      ${c.category}: ${c._count}`);
    });
    
  } catch (error) {
    console.error('\n❌ Erreur:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
