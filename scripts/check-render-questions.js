// Script pour vérifier les questions sur Render via l'API
const API_BASE = 'https://server-jeux-millionnaire.onrender.com';

(async () => {
  try {
    console.log('📊 Vérification des questions sur Render...\n');
    
    const response = await fetch(`${API_BASE}/api/cron/stats`);
    
    if (!response.ok) {
      console.error('❌ Erreur:', response.status, response.statusText);
      return;
    }
    
    const data = await response.json();
    
    console.log('✅ Questions dans la base de données:');
    console.log(`   Total: ${data.questions || 0}`);
    console.log(`   Faciles: ${data.easy || 0}`);
    console.log(`   Moyennes: ${data.medium || 0}`);
    console.log(`   Difficiles: ${data.hard || 0}`);
    console.log(`   Finance: ${data.finance || 0}`);
    console.log(`   Économie: ${data.economy || 0}`);
    console.log(`   Immobilier: ${data.realEstate || 0}`);
    
    if (data.questions < 50) {
      console.log('\n⚠️  ATTENTION: Moins de 50 questions détectées!');
      console.log('   Lancez la génération avec:');
      console.log(`   ${API_BASE}/api/cron/generate-questions`);
    } else if (data.questions < 100) {
      console.log('\n⚠️  Nombre de questions limité.');
      console.log('   Recommandé: au moins 100 questions pour éviter les répétitions');
    } else {
      console.log('\n✅ Nombre de questions suffisant!');
    }
    
  } catch (err) {
    console.error('❌ Erreur:', err.message);
  }
})();
