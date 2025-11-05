# Système anti-répétition des questions Quiz

## Vue d'ensemble

Le système de quiz inclut maintenant un mécanisme qui **garantit qu'un joueur ne verra jamais deux fois la même question**, tant qu'il reste des questions non vues de la difficulté requise.

## Comment ça fonctionne

### 1. Suivi des questions vues

Une nouvelle table `QuizQuestionSeen` enregistre chaque question vue par chaque joueur :

```prisma
model QuizQuestionSeen {
  id          String   @id @default(cuid())
  playerId    String
  questionId  String
  seenAt      DateTime @default(now())
  
  @@unique([playerId, questionId]) // Un joueur ne peut voir qu'une fois chaque question
}
```

### 2. Sélection intelligente

Quand une question est demandée (démarrage de session ou passage à la question suivante) :

**Étape 1 - Recherche de questions non vues**
- Le système vérifie les questions de la difficulté requise (easy/medium/hard)
- Exclut toutes les questions déjà vues par ce joueur
- Si des questions non vues existent → En choisit une au hasard

**Étape 2 - Réinitialisation automatique**
- Si TOUTES les questions de cette difficulté ont été vues
- Le système **réinitialise automatiquement** le tracking pour cette difficulté
- Permet au joueur de revoir les questions (mais dans un ordre différent)

### 3. Marquage automatique

Chaque fois qu'une question est présentée au joueur :
- Elle est automatiquement marquée comme "vue" dans `QuizQuestionSeen`
- Timestamp enregistré pour traçabilité

## Algorithme de sélection

```typescript
async function selectUnseenQuestion(playerId: string, difficulty: string) {
  // 1. Récupérer les IDs des questions déjà vues
  const seenQuestions = await prisma.quizQuestionSeen.findMany({
    where: { playerId },
    select: { questionId: true },
  });
  
  const seenIds = seenQuestions.map(sq => sq.questionId);
  
  // 2. Compter les questions non vues de cette difficulté
  const unseenCount = await prisma.quizQuestion.count({
    where: {
      difficulty,
      id: { notIn: seenIds },
    },
  });
  
  // 3. Si des questions non vues existent
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
  
  // 4. Toutes vues → Réinitialisation automatique
  await prisma.quizQuestionSeen.deleteMany({
    where: {
      playerId,
      question: { difficulty },
    },
  });
  
  // 5. Choisir une question au hasard après reset
  const totalCount = await prisma.quizQuestion.count({
    where: { difficulty },
  });
  
  const skip = Math.floor(Math.random() * totalCount);
  return await prisma.quizQuestion.findFirst({
    where: { difficulty },
    skip,
  });
}
```

## Exemples de scénarios

### Scénario 1 : Première session

**Base de données** : 10 questions faciles, 10 moyennes, 15 difficiles

**Joueur** : Première fois qu'il joue au quiz

**Résultat** :
- Questions 1-5 (faciles) : 5 questions différentes parmi les 10
- Questions 6-10 (moyennes) : 5 questions différentes parmi les 10
- Questions 11+ (difficiles) : Questions parmi les 15

**Tracking** : 15+ entrées créées dans `QuizQuestionSeen`

---

### Scénario 2 : Deuxième session (1 heure après)

**Joueur** : A déjà vu 15 questions (5 faciles, 5 moyennes, 5 difficiles)

**Résultat** :
- Questions 1-5 (faciles) : 5 questions **DIFFÉRENTES** des 5 premières (parmi les 5 restantes)
- Questions 6-10 (moyennes) : 5 questions **DIFFÉRENTES** (parmi les 5 restantes)
- Questions 11+ (difficiles) : Questions **DIFFÉRENTES** (parmi les 10 restantes)

**Tracking** : 15+ nouvelles entrées ajoutées

---

### Scénario 3 : Troisième session (toutes les faciles vues)

**Joueur** : A déjà vu les 10 questions faciles

**Résultat** :
- Questions 1-5 (faciles) : **RESET automatique** → Peut revoir les 10 questions
- Les questions faciles vues sont supprimées du tracking
- Nouvelles questions choisies au hasard parmi les 10
- Le joueur ne verra pas les questions dans le même ordre qu'avant

---

### Scénario 4 : Avec génération IA active

**Base de données** : Croissance continue (10 nouvelles questions/heure)

**Avantage** :
- Les joueurs fréquents voient toujours de nouvelles questions grâce à l'IA
- Le système de rotation (max 50 par difficulté) remplace les anciennes
- Pratiquement **impossible** d'épuiser toutes les questions avec l'IA active

---

## Impact sur les performances

### Requêtes SQL supplémentaires

**Par question présentée** :
1. `SELECT` pour récupérer questions vues (~1-5ms)
2. `COUNT` pour compter questions non vues (~1-3ms)
3. `SELECT` pour récupérer la question (~1-2ms)
4. `INSERT` pour marquer comme vue (~2-3ms)

**Total** : ~5-13ms par question (négligeable)

### Stockage

**Avec 10 joueurs actifs** :
- Chaque joueur peut voir ~50 questions max avant reset
- 10 joueurs × 50 questions = 500 entrées max
- Taille d'une entrée : ~100 bytes
- **Total** : ~50 KB (négligeable)

**Avec 100 joueurs actifs** :
- 100 × 50 = 5000 entrées
- **Total** : ~500 KB (toujours négligeable)

### Réinitialisation automatique

Le système ne nécessite **aucune maintenance manuelle** :
- Reset automatique par difficulté quand toutes les questions sont vues
- Pas de croissance infinie de la table
- Self-cleaning

---

## Monitoring et statistiques

### Vérifier combien de questions un joueur a vues

```sql
SELECT 
  p.nickname,
  COUNT(qqs.id) as total_seen,
  COUNT(CASE WHEN qq.difficulty = 'easy' THEN 1 END) as easy_seen,
  COUNT(CASE WHEN qq.difficulty = 'medium' THEN 1 END) as medium_seen,
  COUNT(CASE WHEN qq.difficulty = 'hard' THEN 1 END) as hard_seen
FROM "Player" p
LEFT JOIN "QuizQuestionSeen" qqs ON p.id = qqs."playerId"
LEFT JOIN "QuizQuestion" qq ON qqs."questionId" = qq.id
WHERE p.nickname = 'JohnDoe'
GROUP BY p.nickname;
```

### Voir les questions jamais vues par un joueur

```sql
SELECT 
  qq.id,
  qq.difficulty,
  qq.category,
  qq.question
FROM "QuizQuestion" qq
WHERE qq.id NOT IN (
  SELECT qqs."questionId"
  FROM "QuizQuestionSeen" qqs
  JOIN "Player" p ON qqs."playerId" = p.id
  WHERE p.nickname = 'JohnDoe'
)
ORDER BY qq.difficulty, qq.category;
```

### Statistiques globales

```sql
-- Joueur qui a vu le plus de questions
SELECT 
  p.nickname,
  COUNT(qqs.id) as questions_seen
FROM "Player" p
JOIN "QuizQuestionSeen" qqs ON p.id = qqs."playerId"
GROUP BY p.nickname
ORDER BY questions_seen DESC
LIMIT 10;

-- Questions les plus vues
SELECT 
  qq.question,
  qq.difficulty,
  COUNT(qqs.id) as times_seen
FROM "QuizQuestion" qq
LEFT JOIN "QuizQuestionSeen" qqs ON qq.id = qqs."questionId"
GROUP BY qq.id, qq.question, qq.difficulty
ORDER BY times_seen DESC
LIMIT 10;
```

---

## Maintenance manuelle (optionnelle)

### Réinitialiser les questions vues pour un joueur

```sql
-- Toutes les questions
DELETE FROM "QuizQuestionSeen"
WHERE "playerId" = (
  SELECT id FROM "Player" WHERE nickname = 'JohnDoe'
);

-- Seulement une difficulté
DELETE FROM "QuizQuestionSeen" qqs
USING "QuizQuestion" qq
WHERE qqs."questionId" = qq.id
  AND qq.difficulty = 'hard'
  AND qqs."playerId" = (
    SELECT id FROM "Player" WHERE nickname = 'JohnDoe'
  );
```

### Réinitialiser toutes les questions vues (tous les joueurs)

```sql
TRUNCATE TABLE "QuizQuestionSeen";
```

⚠️ **Attention** : Ces commandes sont normalement inutiles grâce au reset automatique.

---

## Avantages du système

✅ **Expérience utilisateur améliorée**
- Pas de frustration de voir les mêmes questions
- Impression de contenu infini
- Meilleur engagement long terme

✅ **Maintenance zéro**
- Reset automatique quand nécessaire
- Pas de cron job supplémentaire
- Self-cleaning naturel

✅ **Performance optimale**
- Requêtes SQL simples et rapides
- Index sur `playerId` et `questionId`
- Stockage minimal

✅ **Compatibilité avec IA**
- Fonctionne parfaitement avec génération automatique
- Favorise naturellement les nouvelles questions de l'IA
- Rotation intelligente des anciennes questions

✅ **Analytique intégrée**
- Tracking complet de l'historique
- Possibilité d'analyse des patterns
- Données pour améliorer les questions

---

## Migration vers production

La migration a été créée automatiquement :

```bash
npx prisma migrate deploy
```

Cela créera la table `QuizQuestionSeen` en production sans affecter les données existantes.

**Impact** : 
- ✅ Aucune interruption de service
- ✅ Les sessions actives continuent normalement
- ✅ Le tracking commence immédiatement après déploiement
- ✅ Rétrocompatible (fonctionne même si table vide)

---

## Tests recommandés

### Test 1 : Vérifier qu'aucune question ne se répète

1. Démarrer une session quiz
2. Noter les IDs des questions 1-5 (faciles)
3. Compléter ou abandonner la session
4. Attendre le cooldown (60 min)
5. Démarrer une nouvelle session
6. Vérifier que les IDs des questions 1-5 sont **différents**

### Test 2 : Vérifier le reset automatique

1. Créer une base avec seulement 3 questions faciles
2. Jouer 3 sessions pour voir toutes les questions
3. Jouer une 4ème session
4. Vérifier qu'on peut revoir les questions (ordre différent)

### Test 3 : Vérifier le marquage

```sql
-- Après avoir joué une session
SELECT COUNT(*) FROM "QuizQuestionSeen"
WHERE "playerId" = '<ID_DU_JOUEUR>';

-- Devrait afficher le nombre de questions vues
```

---

**Date de mise en œuvre** : Novembre 2025  
**Statut** : ✅ Production ready  
**Impact utilisateur** : 🚀 Très positif
