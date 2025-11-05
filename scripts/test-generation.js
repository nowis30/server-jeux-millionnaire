// Test simple avec fetch
(async () => {
  try {
    console.log('🤖 Test génération de questions...\n');
    
    const url = 'https://server-jeux-millionnaire.onrender.com/api/quiz/trigger-generation-get?secret=generate123';
    console.log('URL:', url, '\n');
    console.log('⏳ Requête en cours (1-2 minutes)...\n');
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ Erreur:', data.error || response.statusText);
      return;
    }
    
    console.log('✅ Succès!');
    console.log(JSON.stringify(data, null, 2));
    
  } catch (err) {
    console.error('❌ Erreur réseau:', err.message);
  }
})();
