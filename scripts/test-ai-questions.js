// Script de test pour la génération de questions par IA
// Usage: node scripts/test-ai-questions.js

require('dotenv').config({ path: __dirname + '/../.env' });

async function testAI() {
  const { generateQuestionsWithAI } = require('../dist/services/aiQuestions');
  
  console.log('🤖 Test de génération de questions par IA\n');
  
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY non configurée dans .env');
    console.log('\nPour obtenir une clé API:');
    console.log('1. Va sur https://platform.openai.com/api-keys');
    console.log('2. Crée une nouvelle clé API');
    console.log('3. Ajoute-la dans server/.env: OPENAI_API_KEY=sk-...');
    process.exit(1);
  }

  try {
    console.log('Génération de 2 questions moyennes sur la finance...\n');
    const questions = await generateQuestionsWithAI('medium', 'finance', 2);
    
    if (questions.length === 0) {
      console.log('❌ Aucune question générée');
      process.exit(1);
    }

    console.log(`✅ ${questions.length} questions générées :\n`);
    
    questions.forEach((q, i) => {
      console.log(`--- Question ${i + 1} ---`);
      console.log(`Q: ${q.question}`);
      console.log(`A) ${q.optionA}`);
      console.log(`B) ${q.optionB}`);
      console.log(`C) ${q.optionC}`);
      console.log(`D) ${q.optionD}`);
      console.log(`Réponse: ${q.correctAnswer}`);
      console.log(`Difficulté: ${q.difficulty}, Catégorie: ${q.category}\n`);
    });

    console.log('✅ Test réussi !');
  } catch (error) {
    console.error('❌ Erreur:', error.message);
    process.exit(1);
  }
}

testAI();
