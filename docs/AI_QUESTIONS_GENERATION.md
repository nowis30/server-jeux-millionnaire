# Génération de Questions Quiz avec l'IA

## 📋 Vue d'ensemble

Le système peut générer automatiquement des questions de quiz variées et éducatives via l'API OpenAI.

### Améliorations récentes
- ✅ **100 questions par génération** (au lieu de 10)
- ✅ **Détection de doublons** - Vérifie les questions existantes avant d'ajouter
- ✅ **Ordre des réponses mélangé** - Les réponses A, B, C, D sont dans un ordre aléatoire
- ✅ **Plus de diversité** - Temperature augmentée (0.9) pour plus de créativité
- ✅ **Rotation automatique** - Max 100 questions par niveau de difficulté

## 🚀 Génération manuelle

### Prérequis
- Clé API OpenAI (modèle gpt-4o-mini)
- Variable d'environnement `OPENAI_API_KEY`

### Commande

```bash
# Sur Render (via SSH ou console)
OPENAI_API_KEY=sk-votre-clé node scripts/generate-ai-questions.js

# En local
cd server
OPENAI_API_KEY=sk-votre-clé node scripts/generate-ai-questions.js
```

### Résultat attendu

```
🤖 Génération de questions avec l'IA OpenAI

📊 Questions avant génération:
   Faciles: 10
   Moyennes: 10
   Difficiles: 15
   Total: 35

[AI] Génération: 15 questions easy/finance...
[AI] ✓ Question créée (1): "Quel est le symbole boursier du S&P 500 dans le jeu..."
[AI] ✓ Question créée (2): "Quelle action verse des dividendes trimestriels..."
...

✅ Génération terminée avec succès!

📊 Questions après génération:
   Faciles: 45 (+35)
   Moyennes: 43 (+33)
   Difficiles: 37 (+22)
   Total: 125 (+90)

💡 Les questions ont des réponses mélangées pour plus de diversité.
💡 Les doublons ont été automatiquement évités.
```

## 🤖 Génération automatique (Cron)

Le serveur génère automatiquement de nouvelles questions **toutes les heures** via un cron job.

```typescript
// server/src/index.ts
cron.schedule("0 * * * *", async () => {
  const { generateAndSaveQuestions } = await import("./services/aiQuestions");
  await generateAndSaveQuestions();
});
```

## 📊 Distribution des questions

### Par génération
- **40 questions faciles** (15 finance + 15 économie + 10 immobilier)
- **35 questions moyennes** (12 finance + 12 économie + 11 immobilier)
- **25 questions difficiles** (10 finance + 8 économie + 7 immobilier)
- **Total : ~100 questions**

### Rotation
- Max **100 questions par niveau** de difficulté
- Les questions les plus anciennes sont supprimées automatiquement
- Garantit un renouvellement constant du contenu

## 🎯 Fonctionnalités anti-répétition

### 1. Détection de doublons
```typescript
async function isDuplicate(question: string): Promise<boolean>
```
- Compare le texte normalisé (lowercase, trim)
- Vérifie la similarité des mots (90% = doublon)
- Évite les questions trop similaires

### 2. Ordre aléatoire des réponses
```typescript
function shuffleAnswers(q: GeneratedQuestion): GeneratedQuestion
```
- Mélange les options A, B, C, D avec Fisher-Yates
- Ajuste automatiquement `correctAnswer`
- Chaque question a un ordre différent

### 3. Système de questions vues
- Table `QuizQuestionSeen` suit les questions déjà posées à chaque joueur
- Reset automatique quand toutes les questions d'un niveau sont épuisées
- Voir `QUIZ_NO_REPEAT.md` pour plus de détails

## ⚙️ Configuration OpenAI

### Paramètres actuels
```typescript
{
  model: "gpt-4o-mini",        // Économique et performant
  temperature: 0.9,            // Haute créativité
  max_tokens: 3000,            // Permet plus de questions
  response_format: { type: "json_object" }
}
```

### Coût estimé
- Modèle : gpt-4o-mini (~$0.15 / 1M tokens input, ~$0.60 / 1M tokens output)
- Par génération : ~5,000 tokens (~$0.003)
- Par mois (1 génération/heure) : ~$2

## 🔍 Validation des questions

Chaque question générée doit avoir :
- ✅ `question` : Texte de la question
- ✅ `optionA, optionB, optionC, optionD` : 4 options
- ✅ `correctAnswer` : 'A', 'B', 'C', ou 'D'
- ✅ `difficulty` : 'easy', 'medium', ou 'hard'
- ✅ `category` : 'finance', 'economy', ou 'real-estate'

Questions invalides sont automatiquement ignorées.

## 📝 Prompts IA

### System Prompt
Définit le contexte du jeu et les règles de génération.

### User Prompt (par batch)
```
Génère exactement 15 questions de difficulté "easy" dans la catégorie "finance".

IMPORTANT - Critères de création :
1. Les 4 options doivent être plausibles et crédibles
2. Une seule réponse est correcte
3. Les questions doivent être TRÈS VARIÉES et ORIGINALES
4. Évite les questions trop similaires entre elles
5. Le français doit être impeccable
6. Le format JSON doit être valide
7. Chaque question doit être unique
8. Varie les types : définitions, calculs, comparaisons, stratégies
```

## 🚨 Troubleshooting

### Erreur : "OPENAI_API_KEY non définie"
```bash
# Vérifier la variable d'environnement
echo $OPENAI_API_KEY

# Sur Render : Ajouter dans "Environment" settings
OPENAI_API_KEY=sk-votre-clé
```

### Trop de doublons détectés
- Augmenter `temperature` (déjà à 0.9)
- Demander plus de variété dans le prompt
- Générer en plusieurs fois espacées

### Questions de mauvaise qualité
- Ajuster les prompts dans `aiQuestions.ts`
- Réduire `temperature` pour plus de cohérence
- Ajouter des exemples de bonnes questions dans le system prompt

## 📚 Ressources

- [Documentation OpenAI](https://platform.openai.com/docs)
- [Pricing gpt-4o-mini](https://openai.com/pricing)
- [Code source : server/src/services/aiQuestions.ts](../src/services/aiQuestions.ts)
- [Script : server/scripts/generate-ai-questions.js](../scripts/generate-ai-questions.js)

## ✅ Checklist de vérification

Après une génération, vérifier :
- [ ] Nombre total de questions augmenté
- [ ] Pas de questions en doublon visible
- [ ] Réponses dans un ordre varié
- [ ] Questions de qualité (français, logique)
- [ ] Bonnes réponses correctes (tester quelques questions)

---

**Dernière mise à jour** : 5 novembre 2025  
**Contact** : Support technique
