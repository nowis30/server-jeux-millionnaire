# Déploiement Production – Héritier Millionnaire

Ce document rassemble les réglages indispensables pour déployer le serveur Fastify + Prisma et le client Next.js (Vercel) en production avec cookies cross‑site, CORS, cron et sécurité basique.

## 1. Variables d'environnement principales (server/.env)

| Nom | Rôle | Exemple |
|-----|------|---------|
| PORT | Port HTTP d'écoute | 3001 |
| DATABASE_URL | Connexion PostgreSQL / MySQL / etc. | postgres://user:pass@host:5432/db |
| JWT_SECRET | Secret pour signer les tokens | (générer aléatoire 64+ chars) |
| ADMIN_EMAIL | Email auto-promu admin à l'inscription | admin@exemple.com |
| ADMIN_VERIFY_SECRET | Secret pour endpoints admin (promote/reset/seed) | (générer fort) |
| CLIENT_ORIGIN | Liste des origines front autorisées (séparées par virgules) | https://app-prod.vercel.app,https://app-preview-xyz.vercel.app |
| APP_ORIGIN | Origine principale du client (utilisée pour liens email) | https://app-prod.vercel.app |
| GLOBAL_GAME_CODE | Code partie globale unique | GLOBAL |
| CRON_TICK | Expression cron (tick hebdo de jeu) | 0 * * * * |
| MARKET_TICK_CRON | Expression cron marché | 0 */12 * * * * |
| TIMEZONE | Fuseau horaire pour cron | America/Toronto |
| SKIP_EMAIL_VERIFICATION | true pour bypass email vérif | false |
| SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM | Envoi d'emails reset / vérif | (selon fournisseur) |
| SEED_ON_BOOT | Générer seed au démarrage (debug) | false |

### Génération de secrets (PowerShell)
```powershell
# 64 caractères aléatoires
( -join ((65..90)+(97..122)+(48..57) | Get-Random -Count 64 | ForEach-Object {[char]$_}) )
```

## 2. Cookies cross-site

Le serveur définit `hm_auth`, `hm_csrf`, `hm_guest` avec `SameSite=None; Secure`. Conditions:
- Le domaine doit être servi en HTTPS (obligatoire pour SameSite=None).
- En environnement local, utiliser navigateur récent; Safari iOS peut bloquer cookies tiers quand API et front sont sur domaines différents.
- Fallback prévu: header `Authorization: Bearer` (token stocké localStorage `HM_TOKEN`).

## 3. CORS

Logiciel: `@fastify/cors` + Socket.IO.
- Origines autorisées: chaque entrée dans `CLIENT_ORIGIN` + tous les domaines `*.vercel.app` (préviews) + localhost.
- Pour une origine non autorisée, un log `CORS origin refusé` apparaît.

Checklist:
- Vérifier que le domaine final (ex: https://app-prod.vercel.app) figure dans `CLIENT_ORIGIN`.
- Ajouter explicitement les sous-domaines preview si vous souhaitez limiter (sinon wildcard vercel déjà accepté).

## 4. Prisma & Base de données

Au démarrage:
- `prisma migrate deploy` (tente d’appliquer migrations).
- Fallback `prisma db push` si certaines tables manquent.

Recommandations:
- Utiliser migrations versionnées (éviter db push en prod sauf première initialisation).
- Avoir une connexion persistante (Render/Fly: plan avec stockage durable).

## 5. Cron / Simulation

| Tâche | Fréquence | Description |
|-------|-----------|-------------|
| hourlyTick | `CRON_TICK` (par défaut 0 * * * *) | 1 semaine de jeu par heure réelle |
| market daily tick | `MARKET_TICK_CRON` | Avance marché (≈ 5 jours boursiers / heure) |
| Quotas immobiliers | chaque heure + toutes les 5 min | Maintient min 5 par type, total ≥50 |
| Nettoyage ticks marché | toutes les 20 min | Conserve historique allégé |
| Tokens quiz | chaque minute | Distribution automatique |
| Ajustement taux hypothécaire | mensuel | Variation ±0,25% dans [2%,7%] |
| Appréciation annuelle | annuel | Sélection 2–5% |

## 6. Endpoints sensibles

| Endpoint | Protection | Objet |
|----------|-----------|-------|
| POST /api/games/:id/advance-weeks | Admin (JWT isAdmin) | Avance temporelle forcée |
| POST /api/auth/admin/promote | Secret + email | Promotion utilisateur admin |
| POST /api/admin/reset-games | Secret | Reset complet (danger) |
| GET/POST /api/properties/refill/sixplex10 | Public (à sécuriser si nécessaire) | Assurer 10 six‑plex |
| GET/POST /api/properties/refill/tower50x10 | Public | Assurer 10 tours 50 log |

Si vous désirez restreindre les endpoints de refill: ajouter un middleware admin ou un secret (modification rapide possible).

## 7. Flux d’authentification

1. Login/Registration → renvoie JSON `{ token }` + écrit cookie httpOnly `hm_auth` (12h) et cookie CSRF.
2. Client stocke `HM_TOKEN` dans localStorage et envoie `Authorization: Bearer` sur chaque requête.
3. Si 401 à cause d’expiration proche, client déclenche `/api/auth/refresh` et rejoue la requête.

## 8. CSRF

Pour POST/PUT/PATCH/DELETE:
- Client récupère `/api/auth/csrf` pour charger cookie + valeur JSON.
- Envoie entête `x-csrf-token`.
- Tolérances: autorisé si origine approuvée + cookie session présent (compat Safari).

## 9. Sécurité additionnelle recommandée

- Régénérer `JWT_SECRET` avant chaque mise en prod, ne jamais le commiter.
- Activer un monitoring basique (logs d’erreurs Fastify déjà présents).
- Mettre en place un WAF / rate-limit plus strict si trafic public important (actuellement `@fastify/rate-limit` 100 req/min).
- Sauvegardes régulières de la base (dump quotidien + restauration testée).

## 10. Exemple de fichier server/.env

```
PORT=3001
DATABASE_URL=postgres://user:pass@host:5432/heritier
JWT_SECRET=CHANGER_CE_SECRET_ULTRA_LONG
ADMIN_EMAIL=admin@exemple.com
ADMIN_VERIFY_SECRET=SECRET_ADMIN_FORT
CLIENT_ORIGIN=https://app-prod.vercel.app,https://app-preview-abc.vercel.app
APP_ORIGIN=https://app-prod.vercel.app
GLOBAL_GAME_CODE=GLOBAL
CRON_TICK=0 * * * *
MARKET_TICK_CRON=0 */12 * * * *
TIMEZONE=America/Toronto
SKIP_EMAIL_VERIFICATION=false
SMTP_HOST=smtp.exemple.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@exemple.com
SMTP_PASS=motdepasseSMTP
MAIL_FROM="Héritier Millionnaire <no-reply@exemple.com>"
```

## 11. Vérifications post-déploiement

1. Appeler `/api/health` (si présent) ou `/api/games` → retour partie GLOBAL.
2. Appeler `/api/auth/csrf` depuis le front → vérifier réception cookie `hm_csrf`.
3. Login → vérifier cookie `hm_auth` + stockage `HM_TOKEN`.
4. Achat immobilier → confirmer events + auto maintain-bank.
5. Refill six‑plex / tours 50 → vérifier templates supplémentaires.

## 12. Évolutions futures

- Boutons refill incrémental (+10 au lieu de cible fixe) : ajouter endpoints calculant `target = current + delta`.
- Refill tours 100 log: endpoint analogue (`units=100`, min 5).
- Limiter refill aux admins: wrap endpoints avec `requireAdmin`.
- Ajout métriques Prometheus (latence, taux erreurs) et alerte sur échec cron.

---
Dernière mise à jour: 2025-11-08
