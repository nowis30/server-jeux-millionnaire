// Script pour déclencher la génération de questions sur Render
const API_BASE = 'https://server-jeux-millionnaire.onrender.com';
const SECRET = 'generate123'; // Changez ce secret dans les variables d'environnement Render

(async () => {
  try {
    console.log('🤖 Déclenchement de la génération de questions IA...\n');
    
    // Vérifier d'abord les stats actuelles
    console.log('📊 Questions actuelles:');
    const statsResponse = await fetch(`${API_BASE}/api/quiz/public-stats`);
    if (statsResponse.ok) {
      const stats = await statsResponse.json();
      console.log(`   Total: ${stats.questions}`);
      console.log(`   Faciles: ${stats.easy}`);
      console.log(`   Moyennes: ${stats.medium}`);
      console.log(`   Difficiles: ${stats.hard}\n`);
    }
    
    // Déclencher la génération
    console.log('⏳ Génération en cours (peut prendre 1-2 minutes)...\n');
    
    const response = await fetch(`${API_BASE}/api/quiz/trigger-generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET })
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('❌ Erreur:', error.error || response.statusText);
      return;
    }
    
    const data = await response.json();
    console.log('✅ Génération terminée!');
    console.log(`   ${data.created} nouvelles questions créées\n`);
    
    // Vérifier les nouvelles stats
    console.log('📊 Questions après génération:');
    const newStatsResponse = await fetch(`${API_BASE}/api/quiz/public-stats`);
    if (newStatsResponse.ok) {
      const newStats = await newStatsResponse.json();
      console.log(`   Total: ${newStats.questions}`);
      console.log(`   Faciles: ${newStats.easy}`);
      console.log(`   Moyennes: ${newStats.medium}`);
      console.log(`   Difficiles: ${newStats.hard}`);
    }
    
  } catch (err) {
    console.error('❌ Erreur:', err.message);
  }
})();
