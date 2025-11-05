# 🎟️ Système de Tokens pour le Quiz

## Vue d'ensemble

Le quiz utilise un **système de tokens** pour contrôler la fréquence de jeu. Les joueurs gagnent **1 token par heure** automatiquement et doivent consommer **1 token pour démarrer une session de quiz**.

### Pourquoi des tokens ?

- ✅ **Équilibrage du jeu** : Évite l'abus (spam de sessions)
- ✅ **Engagement régulier** : Encourage les joueurs à revenir toutes les heures
- ✅ **Récompense la patience** : Les joueurs qui attendent accumulent des tokens
- ✅ **Plus de cooldown** : Système plus flexible que l'ancien cooldown de 60 minutes

## Fonctionnement

### 1. Gain automatique de tokens

**Fréquence** : 1 token toutes les heures

**Mécanisme** :
- Chaque joueur a un champ `lastTokenEarnedAt` (timestamp du dernier token gagné)
- Le système calcule le temps écoulé depuis ce timestamp
- Si ≥ 1 heure, le joueur gagne un token
- Le timestamp est mis à jour

**Distribution** :
- **Automatique** : Cron job vérifie tous les joueurs chaque minute
- **À la demande** : Calculé aussi quand le joueur vérifie son statut (`GET /status`)

**Exemple** :
```
10h00 : Joueur créé → 1 token (défaut)
11h00 : +1 token → 2 tokens
12h00 : +1 token → 3 tokens
12h30 : Joue 1 session → Consomme 1 token → 2 tokens
13h00 : +1 token → 3 tokens
```

### 2. Consommation de tokens

**Coût** : 1 token par session de quiz

**Moment** : Au démarrage de la session (`POST /quiz/start`)

**Vérifications** :
1. Le joueur a-t-il au moins 1 token ?
   - ❌ Non → Erreur 403 "Pas assez de tokens"
   - ✅ Oui → Continue
2. Consommation du token
3. Création de la session quiz
4. **Si échec** : Le token est automatiquement remboursé

**Remboursement automatique** :
- Session échoue à se créer → Token remboursé
- Aucune question disponible → Token remboursé
- Erreur serveur → Token remboursé

### 3. Accumulation

**Illimité** : Pas de limite maximale de tokens

**Stratégies possibles** :
- **Joueur actif** : Joue toutes les heures → Toujours 0-1 token
- **Joueur patient** : Attend 5 heures → Accumule 5 tokens → 5 sessions d'affilée

**Exemple d'accumulation** :
```
Lundi 10h : Créé → 1 token
Lundi 15h : Pas joué → 6 tokens (1 initial + 5 gagnés)
Lundi 15h30 : Joue 3 sessions → 3 tokens restants
Mardi 10h : Pas joué → 22 tokens (3 + 19 gagnés pendant la nuit)
```

## API et Endpoints

### GET /api/games/:gameId/quiz/status

Retourne le statut du joueur, incluant ses tokens.

**Réponse** :
```json
{
  "canPlay": true,
  "hasActiveSession": false,
  "tokens": 3,
  "secondsUntilNextToken": 2145
}
```

**Champs** :
- `canPlay` : `true` si le joueur a au moins 1 token
- `hasActiveSession` : `true` si une session est en cours
- `tokens` : Nombre de tokens disponibles
- `secondsUntilNextToken` : Temps avant le prochain token (en secondes)

**Comportement** :
- Met automatiquement à jour les tokens avant de répondre
- Calcule le temps restant avant le prochain token

---

### POST /api/games/:gameId/quiz/start

Démarre une nouvelle session de quiz (consomme 1 token).

**Corps** : Aucun

**Réponse succès** (200) :
```json
{
  "sessionId": "clxxx",
  "currentQuestion": 1,
  "currentEarnings": 0,
  "securedAmount": 0,
  "nextPrize": 1000,
  "question": {
    "id": "clyyy",
    "text": "Quelle est la définition du ROI ?",
    "optionA": "...",
    "optionB": "...",
    "optionC": "...",
    "optionD": "..."
  }
}
```

**Erreurs** :
- `403` : Pas assez de tokens
  ```json
  {
    "error": "Pas assez de tokens. Attendez pour en gagner un nouveau."
  }
  ```
- `400` : Session déjà active
- `500` : Erreur serveur (token remboursé automatiquement)

---

## Base de données

### Champs Player

```prisma
model Player {
  // ...autres champs...
  
  quizTokens        Int      @default(1) // Tokens disponibles
  lastTokenEarnedAt DateTime @default(now()) // Dernier token gagné
}
```

**Valeurs par défaut** :
- Nouveau joueur : `quizTokens = 1` (peut jouer immédiatement)
- `lastTokenEarnedAt = now()` (commence le compteur de 1h)

### Requêtes SQL utiles

**Voir les tokens de tous les joueurs** :
```sql
SELECT 
  nickname, 
  "quizTokens" as tokens, 
  "lastTokenEarnedAt" as last_earned,
  NOW() - "lastTokenEarnedAt" as time_since_last
FROM "Player"
WHERE "gameId" IS NOT NULL
ORDER BY "quizTokens" DESC;
```

**Joueurs avec le plus de tokens** :
```sql
SELECT 
  p.nickname,
  p."quizTokens" as tokens,
  g.code as game_code
FROM "Player" p
JOIN "Game" g ON p."gameId" = g.id
WHERE g.status = 'active'
ORDER BY p."quizTokens" DESC
LIMIT 10;
```

**Réinitialiser les tokens d'un joueur** :
```sql
UPDATE "Player"
SET "quizTokens" = 1,
    "lastTokenEarnedAt" = NOW()
WHERE nickname = 'JohnDoe';
```

**Donner des tokens bonus** :
```sql
UPDATE "Player"
SET "quizTokens" = "quizTokens" + 5
WHERE nickname = 'JohnDoe';
```

---

## Cron Job (Distribution automatique)

**Fichier** : `server/src/index.ts`

**Fréquence** : Toutes les minutes (`* * * * *`)

**Fonction** : `distributeTokensToActivePlayers()` (dans `services/quizTokens.ts`)

**Processus** :
1. Récupère tous les jeux actifs
2. Pour chaque joueur de ces jeux :
   - Calcule le temps depuis le dernier token
   - Si ≥ 1 heure → Ajoute un token
   - Met à jour `lastTokenEarnedAt`
3. Log le nombre de tokens distribués

**Logs** :
```
[cron] Tokens distribués: 5 token(s) pour 3 joueur(s)
[tokens] Joueur clxxx a gagné 2 token(s). Total: 5
```

**Optimisation** :
- Ne traite que les joueurs de parties actives
- Skip si aucun token à distribuer
- Batch update pour performances

---

## Service Functions (quizTokens.ts)

### `updatePlayerTokens(playerId: string): Promise<number>`

Met à jour et retourne les tokens actuels du joueur.

**Usage** :
```typescript
const tokens = await updatePlayerTokens(player.id);
console.log(`Joueur a ${tokens} tokens`);
```

**Comportement** :
- Calcule les tokens gagnés depuis `lastTokenEarnedAt`
- Met à jour la DB si des tokens ont été gagnés
- Retourne le total actuel

---

### `consumeQuizToken(playerId: string): Promise<boolean>`

Consomme 1 token pour démarrer une session.

**Usage** :
```typescript
const success = await consumeQuizToken(player.id);
if (!success) {
  return reply.status(403).send({ error: "Pas assez de tokens" });
}
```

**Retour** :
- `true` : Token consommé avec succès
- `false` : Pas assez de tokens (0 tokens disponibles)

---

### `refundQuizToken(playerId: string): Promise<void>`

Rembourse 1 token (en cas d'erreur).

**Usage** :
```typescript
try {
  const session = await createSession();
} catch (err) {
  await refundQuizToken(player.id);
  throw err;
}
```

---

### `getTimeUntilNextToken(playerId: string): Promise<number>`

Calcule le temps restant avant le prochain token.

**Usage** :
```typescript
const seconds = await getTimeUntilNextToken(player.id);
console.log(`Prochain token dans ${seconds} secondes`);
```

**Retour** : Nombre de secondes (0-3600)

---

### `distributeTokensToActivePlayers(): Promise<void>`

Distribue les tokens à tous les joueurs actifs (cron).

**Usage** : Appelé automatiquement par le cron job

---

## Comparaison avec l'ancien système (Cooldown)

| Aspect | Ancien (Cooldown) | Nouveau (Tokens) |
|--------|-------------------|------------------|
| **Limite** | 1 session par heure | 1 token par heure |
| **Flexibilité** | Rigide (doit attendre) | Flexible (accumulation) |
| **Burst play** | ❌ Impossible | ✅ Possible (si tokens accumulés) |
| **Punition échec** | ❌ Cooldown activé même si crash | ✅ Token remboursé si erreur |
| **Visibilité** | ⚠️ Cooldown en minutes | ✅ Tokens + compteur |
| **UX** | Frustrant (attente forcée) | Engageant (récompense) |
| **Gamification** | ❌ Aucune | ✅ Collecte de tokens |

---

## Scénarios d'utilisation

### Scénario 1 : Joueur régulier

```
10h00 : Connexion → 1 token
10h05 : Joue session 1 → 0 token
11h00 : Auto +1 token → 1 token
11h10 : Joue session 2 → 0 token
12h00 : Auto +1 token → 1 token
```

**Résultat** : Peut jouer toutes les heures

---

### Scénario 2 : Joueur occasionnel

```
Lundi 10h : Créé → 1 token
Mercredi 15h : Revient → 1 + 53 tokens = 54 tokens
Mercredi 15h-17h : Joue 10 sessions → 44 tokens restants
```

**Résultat** : Récompensé pour son absence (burst play)

---

### Scénario 3 : Erreur serveur

```
14h00 : Joueur a 2 tokens
14h05 : Démarre session → Consomme 1 token (1 restant)
14h05 : Serveur crash avant création session
       → Token automatiquement remboursé (2 tokens)
14h06 : Rejoueur peut réessayer immédiatement
```

**Résultat** : Pas de perte de token en cas d'erreur

---

## Monitoring et Administration

### Statistiques temps réel

**Tokens totaux en circulation** :
```sql
SELECT SUM("quizTokens") as total_tokens
FROM "Player"
WHERE "gameId" IS NOT NULL;
```

**Moyenne de tokens par joueur** :
```sql
SELECT AVG("quizTokens") as avg_tokens
FROM "Player"
WHERE "gameId" IS NOT NULL;
```

**Distribution des tokens** :
```sql
SELECT 
  "quizTokens" as tokens,
  COUNT(*) as players
FROM "Player"
WHERE "gameId" IS NOT NULL
GROUP BY "quizTokens"
ORDER BY "quizTokens" DESC;
```

### Actions admin

**Donner des tokens bonus à tous** :
```sql
UPDATE "Player"
SET "quizTokens" = "quizTokens" + 5
WHERE "gameId" IS NOT NULL;
```

**Reset des tokens (événement spécial)** :
```sql
UPDATE "Player"
SET "quizTokens" = 10,
    "lastTokenEarnedAt" = NOW()
WHERE "gameId" IN (
  SELECT id FROM "Game" WHERE status = 'active'
);
```

---

## Migration depuis l'ancien système

**Changements** :
1. ✅ Suppression du système de cooldown (60 minutes)
2. ✅ Ajout des champs `quizTokens` et `lastTokenEarnedAt`
3. ✅ Tous les joueurs existants reçoivent 1 token par défaut
4. ✅ Nouveau cron job pour distribution automatique

**Compatibilité** :
- Les sessions actives existantes continuent normalement
- Les joueurs existants peuvent jouer immédiatement (1 token par défaut)
- Pas d'interruption de service

---

## Améliorations futures possibles

### Option 1 : Limite maximum de tokens

```typescript
const MAX_TOKENS = 24; // Maximum 24 heures d'accumulation

if (player.quizTokens >= MAX_TOKENS) {
  // Ne pas ajouter plus de tokens
  return player.quizTokens;
}
```

**Avantage** : Encourage le jeu régulier (use it or lose it)

---

### Option 2 : Bonus pour streaks

```typescript
// Si le joueur joue tous les jours pendant 7 jours
// → Bonus de 3 tokens

if (player.streakDays >= 7) {
  await prisma.player.update({
    where: { id: player.id },
    data: { quizTokens: { increment: 3 } },
  });
}
```

**Avantage** : Récompense la fidélité

---

### Option 3 : Achat de tokens avec cash du jeu

```typescript
// Acheter 1 token pour $50,000
if (player.cash >= 50000) {
  await prisma.player.update({
    where: { id: player.id },
    data: {
      cash: { decrement: 50000 },
      quizTokens: { increment: 1 },
    },
  });
}
```

**Avantage** : Monétisation in-game

---

### Option 4 : Tokens premium différents

```typescript
// 2 types de tokens:
// - quizTokensBasic (1/heure, questions normales)
// - quizTokensPremium (1/jour, questions x2 gains)

model Player {
  quizTokensBasic   Int @default(1)
  quizTokensPremium Int @default(0)
}
```

**Avantage** : Système à plusieurs niveaux

---

## Tests recommandés

### Test 1 : Vérifier gain automatique

1. Créer un joueur
2. Noter son nombre de tokens initial (devrait être 1)
3. Attendre 1 minute (le cron tourne chaque minute)
4. Vérifier que `lastTokenEarnedAt` est récent
5. Attendre 61 minutes
6. Vérifier que tokens a augmenté de 1

### Test 2 : Vérifier consommation

1. Joueur avec 2 tokens
2. Démarrer une session → Devrait passer à 1 token
3. Vérifier en DB : `SELECT quizTokens FROM Player WHERE id = '...'`

### Test 3 : Vérifier remboursement

1. Modifier le code pour forcer une erreur après consommation
2. Démarrer session → Erreur
3. Vérifier que le token a été remboursé

---

**Date de mise en œuvre** : Novembre 2025  
**Statut** : ✅ Production ready  
**Impact utilisateur** : 🎮 Très positif (gamification++)
