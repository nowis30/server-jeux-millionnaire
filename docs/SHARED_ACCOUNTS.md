# Compte unique pour tous les jeux

Ce document explique comment éviter d'imposer aux joueurs un changement de mot de passe lorsqu'ils passent d'un jeu (Héritier Millionnaire, Drag, quiz, applications mobiles…) à un autre. L'objectif est d'utiliser le même compte (email + mot de passe) dans l'ensemble de l'écosystème et de conserver une session partagée.

## 1. Service d'identité unique

Le backend `server-jeux-millionnaire` joue déjà le rôle de fournisseur d'identité :

- La table `User` de Prisma contient les identifiants globaux (email unique, hash du mot de passe, drapeaux admin, vérification email, etc.).
- Tous les jeux doivent effectuer leurs opérations d'authentification contre `https://server-jeux-millionnaire.onrender.com` (ou son équivalent local via le proxy Next/Capacitor).
- Les routes existantes `/api/auth/login`, `/api/auth/register`, `/api/auth/me`, `/api/auth/refresh`, `/api/auth/guest-token`, `/api/auth/request-reset` couvrent l'ensemble des besoins (utilisateur complet ou invité).

Tant que chaque client (Drag standalone, Next.js, APK, Expo, etc.) pointe vers cette même API, un mot de passe modifié s'applique automatiquement à tous les jeux sans autre action.

## 2. Cookies + bearer partagés

- Lors d'un login réussi, le serveur émet le cookie `hm_auth` (`SameSite=None`, `Secure`) et renvoie aussi un JWT (`token`) que les clients peuvent stocker via `localStorage`.
- Tous les clients doivent envoyer `credentials: "include"` afin que le cookie soit joint, même si le front est hébergé sur GitHub Pages, Vercel ou un APK.
- Optionnel : transmettre `Authorization: Bearer <token>` pour contourner les blocages de cookies (Capacitor, navigateurs très stricts). Les deux mécanismes sont supportés par `auth.ts` et garantissent la réutilisation du même compte entre jeux.

## 3. Checklist d'intégration pour un nouveau jeu

1. Définir `API_BASE` vers `https://server-jeux-millionnaire.onrender.com` (ou garder vide en dev pour utiliser les proxys Next).
2. Pour chaque appel mutateur (`POST/PUT/PATCH/DELETE`), ajouter l'en-tête `x-csrf-token` obtenu via `/api/auth/csrf`.
3. Stocker le JWT dans `localStorage` si besoin (clé libre) mais **ne jamais** dériver un autre mot de passe. Si un utilisateur doit se reconnecter, il réutilise simplement son email + mot de passe existant.
4. Pour les appareils sans cookies (applis natives), appeler `/api/auth/guest-token` pour les invités puis `/api/auth/login` pour un compte complet ; le token reste valable 12 h et peut être rafraîchi via `/api/auth/refresh`.
5. Pour partager l'ID joueur entre jeux, sérialiser `playerId` dans `localStorage` (clé `hm-session` comme dans Drag) ou via `X-Player-ID`.

## 4. Comment migrer un jeu existant

1. Supprimer toute logique locale qui stocke des mots de passe distincts.
2. Remplacer les appels REST d'auth propriétaire par les routes décrites ci-dessus.
3. Lors de la première connexion d'un joueur, si aucun `User` n'existe, appeler `/api/auth/register` (email + mot de passe) et laisser le serveur créer le compte global.
4. Si votre jeu maintient son propre modèle `Player`, liez-le au `User` via l'email (ex. `player.guestId = user.email`). Vous n'avez PAS besoin de forcer un reset : il suffit de récupérer l'utilisateur par email lors de la création du joueur.

## 5. Scénarios fréquents

| Situation | Solution |
|-----------|----------|
| L'utilisateur passe du jeu Drag au simulateur immobilier | Les deux frontends utilisent déjà le même backend. Un seul mot de passe suffit ; aucune action n'est requise si les cookies sont transmis. |
| L'utilisateur a oublié son mot de passe | `/api/auth/request-reset` envoie un email valable 30 minutes. Une fois changé, ce nouveau mot de passe fonctionne pour TOUS les jeux. |
| Un nouvel APK/jeu Unity doit être publié | Intégrer le client HTTP au même backend (points 1 à 4). On peut démarrer en mode invité (`guest-token`) puis proposer la connexion complète facultative. |
| Partager une session sans demander le mot de passe | Utiliser le cookie `hm_auth` + l'end-point `/api/auth/me` dès le chargement pour récupérer l'identité. |

## 6. À retenir

- **Un seul mot de passe par email** car un seul `User` est stocké dans la base Render.
- **Aucun jeu ne doit gérer ses propres mots de passe** ou forcer un reset spécifique.
- **Si un reset est effectué, il affecte tout l'écosystème** : il n'est donc plus nécessaire de "changer de mot de passe quand on change de jeu".
- **Toujours utiliser les mêmes routes d'auth** pour garantir la cohérence.

Avec cette architecture, un joueur crée/actualise son mot de passe une fois et l'utilise partout. Les jeux n'ont plus qu'à consommer le service d'identité existant.
