# 🤖 Génération de Questions par IA

Le système de quiz peut générer automatiquement de nouvelles questions toutes les heures grâce à l'API OpenAI (GPT-4).

**✨ Bonus** : Le système inclut aussi un **mécanisme anti-répétition** qui garantit qu'un joueur ne verra jamais deux fois la même question (voir [QUIZ_NO_REPEAT.md](./QUIZ_NO_REPEAT.md) pour les détails).

## Configuration

### 1. Obtenir une clé API OpenAI

1. Va sur https://platform.openai.com/api-keys
2. Connecte-toi ou crée un compte
3. Clique sur **"Create new secret key"**
4. Copie la clé (elle commence par `sk-...`)
5. **Important** : Ajoute des crédits sur ton compte (minimum $5)

### 2. Configurer la clé API

#### En local (développement)
Ajoute dans `server/.env` :
```env
OPENAI_API_KEY=sk-proj-...votre-cle...
```

#### Sur Render (production)
1. Va sur Render Dashboard
2. Sélectionne ton service `server-jeux-millionnaire`
3. Onglet **"Environment"**
4. Ajoute une nouvelle variable :
   - Nom : `OPENAI_API_KEY`
   - Valeur : `sk-proj-...votre-cle...`
5. **Save Changes** (cela redéploie automatiquement)

## Fonctionnement

### Génération automatique
- **Fréquence** : Toutes les heures (cron job)
- **Quantité** : ~10 questions par heure
  - 2 faciles finance
  - 1 facile économie
  - 2 moyennes finance
  - 2 moyennes immobilier
  - 1 difficile finance
  - 1 difficile économie
- **Rotation** : Maximum 50 questions par niveau de difficulté
  - Les plus anciennes sont supprimées automatiquement

### Génération manuelle (admin)

**Via API** :
```bash
curl -X POST https://server-jeux-millionnaire.onrender.com/api/quiz/generate-ai \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

**Statistiques** :
```bash
curl https://server-jeux-millionnaire.onrender.com/api/quiz/stats \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Test en local

```bash
cd server
npm run build
node scripts/test-ai-questions.js
```

Ce script génère 2 questions test pour vérifier que l'API fonctionne.

## Prompts et qualité

Le système utilise des prompts optimisés pour générer des questions :

### Difficultés
- **Facile** : Concepts de base, définitions, règles du jeu
- **Moyen** : Calculs simples, stratégies, comparaisons
- **Difficile** : Calculs complexes, stratégies optimales, concepts avancés

### Catégories
- **Finance** : Marché boursier, actions, dividendes (SP500, QQQ, TSX, GLD, TLT)
- **Économie** : Mécaniques du jeu, taux d'intérêt, stratégies
- **Immobilier** : Hypothèques, refinancement, appréciation

### Format
Chaque question contient :
- Texte de la question
- 4 options (A, B, C, D)
- Réponse correcte
- Difficulté et catégorie
- Explication (stockée mais pas encore affichée)

## Coûts

**Modèle utilisé** : `gpt-4o-mini` (économique)

Estimation des coûts :
- ~10 questions/heure = 240 questions/jour
- Coût : ~$0.15-0.30 par jour = **$4.50-9 par mois**

Pour réduire les coûts :
1. Réduire la fréquence (ex: toutes les 3 heures au lieu de 1)
2. Réduire le nombre de questions par batch
3. Désactiver temporairement en commentant le cron job

## Désactivation

Pour désactiver complètement la génération IA :

1. **Ne pas configurer** `OPENAI_API_KEY`
2. **OU** commenter le cron job dans `server/src/index.ts` :

```typescript
// Désactiver génération IA
/*
cron.schedule("0 * * * *", async () => {
  app.log.info("[cron] AI question generation (every hour)");
  // ...
}, { timezone: env.TIMEZONE });
*/
```

Le quiz continuera à fonctionner avec les 35 questions de base du seed initial.

## Monitoring

Pour suivre l'activité de génération :

**Logs Render** :
```
[cron] AI question generation (every hour)
[AI] 8/10 questions générées avec succès
Questions IA générées automatiquement
```

**Statistiques** :
```bash
# Nombre total de questions en base
curl https://server-jeux-millionnaire.onrender.com/api/quiz/stats \
  -H "Authorization: Bearer YOUR_JWT"
```

## Troubleshooting

### Erreur "OPENAI_API_KEY non configurée"
→ Ajoute la clé dans les variables d'environnement (voir Configuration)

### Erreur "Pas de réponse de l'IA"
→ Vérifie que tu as des crédits sur ton compte OpenAI

### Erreur "Rate limit exceeded"
→ Réduis la fréquence du cron job ou augmente la limite sur OpenAI

### Questions de mauvaise qualité
→ Ajuste les prompts dans `server/src/services/aiQuestions.ts`

## Améliorations futures

- [ ] Ajout d'images pour certaines questions
- [ ] Génération contextuelle (basée sur l'état du marché actuel)
- [ ] Questions multi-étapes (scénarios)
- [ ] Système de vote pour les meilleures questions
- [ ] Export/import de questions
