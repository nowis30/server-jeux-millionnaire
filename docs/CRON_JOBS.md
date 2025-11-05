# Tâches automatisées (Cron Jobs)

Ce document liste toutes les tâches planifiées qui s'exécutent automatiquement en arrière-plan.

## Vue d'ensemble

| Tâche | Fréquence | Expression Cron | Fonction |
|-------|-----------|-----------------|----------|
| **Tick de marché** | Toutes les 10 secondes | `*/10 * * * * *` | Met à jour les prix des actifs boursiers |
| **Nettoyage des ticks** | Toutes les 20 minutes | `*/20 * * * *` | Supprime les anciens ticks (garde 100 récents + échantillonnage) |
| **Génération IA questions** | Toutes les heures | `0 * * * *` | Génère 10 nouvelles questions quiz avec OpenAI |
| **Distribution tokens quiz** | Toutes les minutes | `* * * * *` | Distribue 1 token/heure aux joueurs actifs |

## Détails des tâches

### 1. Tick de marché (Market Tick)

**Fichier**: `server/src/index.ts` (ligne ~270)

```typescript
cron.schedule("*/10 * * * * *", async () => {
  const games = await prisma.game.findMany({ where: { status: "active" } });
  for (const game of games) {
    await processTick(game.id);
  }
});
```

**Description**:
- Exécution: **Toutes les 10 secondes** (360 fois par heure)
- Simulé: ~1.4 années de marché par heure réelle
- Actions:
  - Calcule les nouveaux prix des 5 actifs (SP500, QQQ, TSX, GLD, TLT)
  - Vérifie et déclenche les dividendes trimestriels
  - Met à jour les taux hypothécaires mensuellement
  - Envoie les données via WebSocket aux clients connectés

**Performances**:
- Durée moyenne: ~50-150ms par tick
- Charge: Modérée (peut augmenter avec nombre de joueurs)

---

### 2. Nettoyage des ticks (Tick Cleanup)

**Fichier**: `server/src/index.ts` (ligne ~285)

```typescript
cron.schedule("*/20 * * * *", async () => {
  const result = await cleanupOldTicks();
  console.log(`[cron] Tick cleanup:`, result);
});
```

**Description**:
- Exécution: **Toutes les 20 minutes** (72 fois par jour)
- Objectif: Éviter l'accumulation de centaines de milliers de ticks
- Stratégie:
  - **Garde les 100 derniers ticks** de chaque symbole (pour graphiques temps réel)
  - **Garde 1 tick sur 100** des ticks plus anciens (pour historique long terme)
  - Supprime tout le reste

**Exemple de résultat**:
```
[cron] Tick cleanup: { deleted: 374877, kept: 500 }
```

**Impact**:
- Réduit la taille de la base de données de 99%+
- Accélère les requêtes de marché de plusieurs secondes
- Historique long terme toujours disponible (échantillonné)

**Fichier source**: `server/src/services/tickCleanup.ts`

---

### 3. Génération IA de questions (AI Question Generation)

**Fichier**: `server/src/index.ts` (ligne ~295)

```typescript
cron.schedule("0 * * * *", async () => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("[cron] AI generation skipped: OPENAI_API_KEY not configured");
      return;
    }
    const created = await generateAndSaveQuestions();
    console.log(`[cron] AI generation: ${created} questions created`);
  } catch (error) {
    console.error("[cron] AI generation error:", error.message);
  }
});
```

**Description**:
- Exécution: **À la minute 00 de chaque heure** (24 fois par jour)
- Génère: **10 nouvelles questions** par exécution (mix facile/moyen/difficile)
- Catégories: Finance, économie, immobilier
- Technologies: OpenAI GPT-4o-mini (~$0.15-0.30 par jour)

**Système de rotation**:
- Maximum 50 questions par niveau de difficulté
- Quand limite atteinte, supprime les plus anciennes
- Total max: 150 questions dans la base

**Dégradation gracieuse**:
- Si `OPENAI_API_KEY` non configurée → Skip silencieusement
- Quiz fonctionne avec les 35 questions de base
- En cas d'erreur API → Log l'erreur, continue normalement

**Fichier source**: `server/src/services/aiQuestions.ts`

**Monitoring**:
- Logs Render: Chercher `[cron] AI generation:` ou `[AI]`
- Endpoint stats: `GET /api/quiz/stats` (admin)
- Génération manuelle: `POST /api/quiz/generate-ai` (admin)

**Coûts estimés**:
- Par jour: $0.15 - $0.30
- Par mois: $4.50 - $9.00
- Variable selon longueur des questions générées

---

## Configuration

### Désactiver une tâche

**Option 1: Commenter dans le code**

Éditer `server/src/index.ts` et commenter le `cron.schedule(...)`:

```typescript
// Désactiver le nettoyage des ticks:
// cron.schedule("*/20 * * * *", async () => { ... });
```

**Option 2: Variable d'environnement (pour AI uniquement)**

Ne pas configurer `OPENAI_API_KEY` → AI generation est skippée automatiquement

### Modifier la fréquence

Éditer l'expression cron dans `server/src/index.ts`:

```typescript
// Exemples:
"*/10 * * * * *"  // Toutes les 10 secondes
"*/5 * * * *"     // Toutes les 5 minutes
"0 */3 * * *"     // Toutes les 3 heures (à la minute 00)
"0 0 * * *"       // Une fois par jour à minuit
```

**Référence expressions cron**: https://crontab.guru/

### Monitoring en production

**Render (logs)**:
1. Ouvrir Render Dashboard → Service `server-jeux-millionnaire`
2. Onglet **Logs**
3. Chercher:
   - `[cron] Market tick` (devrait apparaître toutes les 10s)
   - `[cron] Tick cleanup` (toutes les 20 min)
   - `[cron] AI generation` (toutes les heures)

**Vérifier si les tâches fonctionnent**:
```bash
# Dans les logs, chercher ces patterns:
grep "[cron]" logs.txt

# Exemples de logs normaux:
# [cron] Market tick completed for game 1 (symbol: SP500, price: 450.23)
# [cron] Tick cleanup: { deleted: 5432, kept: 500 }
# [cron] AI generation: 10 questions created
# [cron] Tokens distribués: 5 token(s) pour 3 joueur(s)
```

---

### 4. Distribution des tokens quiz (Token Distribution)

**Fichier**: `server/src/index.ts` (ligne ~307)

```typescript
cron.schedule("* * * * *", async () => {
  try {
    const { distributeTokensToActivePlayers } = await import("./services/quizTokens");
    await distributeTokensToActivePlayers();
  } catch (err) {
    app.log.error({ err }, "Erreur distribution tokens quiz");
  }
});
```

**Description**:
- Exécution: **Toutes les minutes** (60 fois par heure, 1440 fois par jour)
- Objectif: Distribuer automatiquement les tokens gagnés aux joueurs
- Règle: Chaque joueur gagne **1 token par heure** (consommé pour jouer au quiz)

**Processus** :
1. Récupère tous les jeux actifs
2. Pour chaque joueur de ces jeux :
   - Calcule le temps depuis `lastTokenEarnedAt`
   - Si ≥ 1 heure → Ajoute 1 token
   - Met à jour `quizTokens` et `lastTokenEarnedAt`
3. Log le nombre de tokens distribués

**Exemple de résultat**:
```
[cron] Tokens distribués: 5 token(s) pour 3 joueur(s)
[tokens] Joueur clxxx a gagné 2 token(s). Total: 5
```

**Caractéristiques** :
- Distribution équitable (1 token/heure pour tous)
- Accumulation illimitée (pas de plafond)
- Skip silencieux si aucun token à distribuer
- Performances optimisées (batch queries)

**Fichier source**: `server/src/services/quizTokens.ts`

**Documentation complète**: [QUIZ_TOKENS.md](./QUIZ_TOKENS.md)

---

## Timezone

Par défaut: **America/Toronto** (EST/EDT)

Configurable via variable d'environnement:
```env
TIMEZONE=America/Toronto
```

Impact:
- Les dividendes trimestriels utilisent cette timezone
- Les mises à jour de taux hypothécaires mensuelles aussi
- Les expressions cron s'exécutent dans cette timezone

## Dépannage

### Les ticks ne se génèrent pas

**Vérifications**:
1. Un jeu avec `status = "active"` existe ?
   ```sql
   SELECT id, status FROM "Game";
   ```
2. Les logs montrent `[cron] Market tick` ?
3. Le serveur a redémarré récemment ? (cron prend ~10s à démarrer)

### Le nettoyage ne supprime rien

**Raison probable**: Moins de 100 ticks par symbole dans la DB

Le nettoyage ne supprime que si **plus de 100 ticks** existent pour un symbole donné.

### AI generation ne fonctionne pas

**Checklist**:
- [ ] `OPENAI_API_KEY` configurée dans Render ?
- [ ] Clé API valide et crédits disponibles ?
- [ ] Logs montrent `[cron] AI generation skipped` (clé manquante) ou `[cron] AI generation error` (autre erreur) ?
- [ ] Tester manuellement: `node scripts/test-ai-questions.js` (après `npm run build`)

**Erreurs courantes**:
- `401 Unauthorized`: Clé API invalide ou expirée
- `429 Rate Limit`: Trop de requêtes, attendre 1 minute
- `insufficient_quota`: Ajouter des crédits sur OpenAI

## Scripts manuels

Pour déclencher manuellement une tâche (utile pour tests):

```bash
# Nettoyage des ticks:
node scripts/manual-cleanup.js

# Génération AI (avec OPENAI_API_KEY configurée):
npm run build
node scripts/test-ai-questions.js

# Ou via API (admin requis):
curl -X POST https://server-jeux-millionnaire.onrender.com/api/quiz/generate-ai \
  -H "Authorization: Bearer ADMIN_JWT_TOKEN"
```

---

**Dernière mise à jour**: Janvier 2025
