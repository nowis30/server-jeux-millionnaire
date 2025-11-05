# Héritier Millionnaire - Server

API backend pour le jeu de simulation économique multijoueur « Héritier Millionnaire ».

**Stack**: Node.js + Fastify + Prisma + PostgreSQL + Socket.IO + node-cron

## Déploiement actuel

- **API Production**: https://server-jeux-millionnaire.onrender.com
- **Base de données**: PostgreSQL managé sur Render
- **Client Web**: https://client-jeux-millionnaire.vercel.app

## Fonctionnalités

### Quiz "Quitte ou Double" avec IA

- **35 questions de base** + **génération automatique IA** (10 questions/heure)
- **Aucune répétition** : Système intelligent qui garantit que chaque joueur ne voit jamais deux fois la même question
- **Paliers progressifs** : 5 faciles ($1k→$5k) → 5 moyennes ($10k→$50k) → difficiles ($75k→$5M+)
- **Seuils de sécurité** : $5k, $50k, $500k, $5M (gains garantis)
- **Cooldown** : 60 minutes entre chaque session
- **IA OpenAI GPT-4o-mini** : Génération automatique pour questions toujours fraîches (~$5-9/mois)
- **Catégories** : Finance, économie, immobilier
- **Admin** : Endpoints pour génération manuelle et statistiques
- 📚 [Documentation IA](./docs/AI_QUESTIONS.md) | 🚫 [Anti-répétition](./docs/QUIZ_NO_REPEAT.md)

### Optimisations de performance

- **Nettoyage automatique des ticks** (toutes les 20 minutes):
  - Conserve les 100 derniers ticks de chaque symbole boursier
  - Conserve 1 tick sur 100 des ticks plus anciens (échantillonnage pour historique)
  - Avec 360 ticks/heure (10s par tick), cela évite l'accumulation de centaines de milliers de ticks
  - Réduit les temps de chargement de la page Bourse de plusieurs secondes
  
- **Cache mémoire** (~90s TTL) sur les endpoints marché:
  - `GET /api/games/:id/markets/latest`
  - `GET /api/games/:id/markets/returns`
  - Bypass possible avec `?debug=1`

### Simulation économique

- **Marché accéléré**: 1 tick toutes les 10 secondes = 360 ticks/heure ≈ 1.4 années simulées par heure réelle
- **5 actifs boursiers**: SP500, QQQ, TSX, GLD, TLT
- **Dividendes trimestriels**: versés automatiquement le dernier jour ouvrable de mars, juin, septembre et décembre
- **Immobilier**: achat/vente, refinancement, réparations, appréciation annuelle [2%-5%]
- **Taux hypothécaires variables**: ajustés mensuellement de ±0.25% dans la plage [2%-7%]

## Installation locale

### Pré-requis

- Node.js 18+
- PostgreSQL (local ou Docker)

### Configuration

1. Copier `.env.example` vers `.env` et ajuster les valeurs:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/heritier
PORT=3001
CRON_TICK=0 * * * *
TIMEZONE=America/Toronto
CLIENT_ORIGINS=http://localhost:3000,https://client-jeux-millionnaire.vercel.app
JWT_SECRET=<génére-un-secret-long-et-aléatoire>
ADMIN_EMAIL=admin@example.com
SEED_ON_BOOT=false

# Optionnel: Génération IA de questions quiz
OPENAI_API_KEY=sk-proj-...
```

2. Installer les dépendances:

```bash
npm install
```

3. Configurer Prisma:

```bash
npx prisma generate
npx prisma migrate deploy
```

4. (Optionnel) Seed des données de base:

```bash
node prisma/seed.js

# Pour les questions quiz:
node scripts/seed-quiz.js
```

### Démarrage

```bash
# Développement (avec hot reload)
npm run dev

# Production
npm run build
npm start
```

L'API sera disponible sur http://localhost:3001

## Scripts d'administration

### 1. Redémarrage de partie (via base de données)

Utilise Prisma pour se connecter directement à la base de production et redémarrer une partie.

```bash
# 1. Créer scripts/.env avec l'URL EXTERNE de la base Render
echo "DATABASE_URL=postgresql://user:pass@host.render.com/dbname" > scripts/.env

# 2. Exécuter le script
node scripts/restart-game.js
```

**Ce que fait le script**:
- Affiche l'état avant redémarrage (nombre de joueurs, ticks, etc.)
- Supprime toutes les données de la partie (joueurs, positions, ticks, etc.)
- Réinitialise le statut de la partie à `running`
- Affiche l'état après redémarrage

### 2. Nettoyage manuel des ticks

Nettoie manuellement les ticks de marché (même logique que le cron automatique).

```bash
# 1. Créer scripts/.env avec l'URL EXTERNE de la base Render
echo "DATABASE_URL=postgresql://user:pass@host.render.com/dbname" > scripts/.env

# 2. Exécuter le script
node scripts/cleanup-ticks-manual.js
```

**Ce que fait le script**:
- Affiche le nombre de ticks avant nettoyage pour chaque symbole
- Conserve les 100 derniers ticks + 1 sur 100 des anciens
- Affiche le nombre de ticks après nettoyage
- Retourne le nombre total de ticks supprimés

**Note**: Le nettoyage automatique s'exécute toutes les 20 minutes via cron job en production.

### 3. Récupérer l'URL externe de la base de données

Sur Render.com:
1. Dashboard > PostgreSQL database
2. Chercher **"External Database URL"** (PAS "Internal")
3. Copier l'URL qui ressemble à: `postgresql://user:pass@host.ohio-postgres.render.com/dbname`

## Endpoints API

### Parties

- `GET /api/games` — Liste des parties
- `POST /api/games` — Créer une partie
- `GET /api/games/:id/state` — État d'une partie
- `POST /api/games/:id/join` — Rejoindre une partie
- `POST /api/games/:id/start` — Démarrer une partie (admin)
- `POST /api/games/:id/restart` — Redémarrer une partie (admin, nécessite JWT)

### Administration (admin uniquement)

- `GET /api/games/:id/diagnostic` — Statistiques de la base (nombre de ticks, joueurs, etc.)
- `POST /api/games/:id/cleanup-ticks` — Nettoyer les ticks manuellement
- `POST /api/games/:id/restart-direct` — Redémarrer sans transaction (pour grandes bases)

### Marché

- `GET /api/games/:id/markets/latest` — Prix actuels des 5 actifs (cache 90s)
- `GET /api/games/:id/markets/returns?window=1d|7d|30d` — Rendements par fenêtre
- `GET /api/games/:id/markets/holdings/:playerId` — Portefeuille d'un joueur
- `POST /api/games/:id/markets/buy` — Acheter un actif
- `POST /api/games/:id/markets/sell` — Vendre un actif

### Immobilier

- `GET /api/properties/templates` — Liste des propriétés disponibles
- `POST /api/games/:id/properties/purchase` — Acheter une propriété
- `POST /api/games/:id/properties/:holdingId/refinance` — Refinancer
- `POST /api/games/:id/properties/:holdingId/sell` — Vendre

### Annonces P2P

- `GET /api/games/:gameId/listings` — Liste des annonces
- `POST /api/games/:gameId/listings` — Créer une annonce
- `POST /api/games/:gameId/listings/:id/cancel` — Annuler une annonce
- `POST /api/games/:gameId/listings/:id/accept` — Accepter une annonce

## Cron Jobs

| Intervalle | Description |
|------------|-------------|
| **10 secondes** | Tick de marché (nouveaux prix des 5 actifs) |
| **Horaire** | Tick de simulation (paiements hypothécaires, loyers, etc.) |
| **20 minutes** | Nettoyage automatique des ticks (100 derniers + échantillonnage 1/100) |
| **03:00 daily** | Rafraîchissement nocturne |
| **1er du mois** | Ajustement taux hypothécaires (±0.25%) |
| **1er janvier** | Tirage appréciation annuelle immobilière [2%-5%] |

## WebSocket (Socket.IO)

Événements en temps réel:
- `lobby-update` — Changements dans le lobby
- `game-update` — État de la partie
- `leaderboard` — Classement actualisé
- `listing:create` — Nouvelle annonce
- `listing:cancel` — Annonce annulée
- `listing:accept` — Annonce acceptée

## Variables d'environnement (Production)

Sur Render.com, configurer:

```env
DATABASE_URL=postgresql://... (fournie par Render PostgreSQL)
PORT=3001 (ou valeur imposée par la plateforme)
CLIENT_ORIGINS=https://client-jeux-millionnaire.vercel.app,capacitor://localhost
JWT_SECRET=<générer-un-secret-long-et-aléatoire>
ADMIN_EMAIL=smorin_23@hotmail.com
TIMEZONE=America/Toronto
CRON_TICK=0 * * * *
NODE_ENV=production
```

## Authentification Admin

Pour utiliser les endpoints admin (`/restart`, `/cleanup-ticks`, etc.):

1. Se connecter sur le client web avec l'email `ADMIN_EMAIL`
2. Ouvrir les DevTools (F12) > Onglet Console
3. Récupérer le token JWT: `localStorage.HM_TOKEN`
4. Utiliser ce token dans l'en-tête: `Authorization: Bearer <token>`

Le token JWT est valable 12 heures. Si vous obtenez 401/403, reconnectez-vous.

## Documentation OpenAPI

- Fichier: `openapi/openapi.yml`
- UI Swagger locale: http://localhost:3001/docs

## Logs et monitoring

En production sur Render:
1. Dashboard > Service > Logs
2. Filtrer par `[cron]` pour voir les exécutions automatiques
3. Filtrer par `[cleanupTicks]` pour voir les nettoyages automatiques

## Support

Pour toute question ou problème:
- Issues GitHub: [server-jeux-millionnaire](https://github.com/nowis30/server-jeux-millionnaire)
- Email admin: smorin_23@hotmail.com
