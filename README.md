# Héritier Millionnaire — backend Supabase

Le backend de production d’Héritier Millionnaire est entièrement hébergé sur
Supabase : authentification, PostgreSQL, Edge Function et tâches planifiées.
Le client statique reste déployé sur Vercel.

## Production

- Client : <https://client-jeux-millionnaire.vercel.app>
- API : <https://smwrpejnegtssmtmnecb.supabase.co/functions/v1/heritier-api>
- Santé : <https://smwrpejnegtssmtmnecb.supabase.co/functions/v1/heritier-api/health>
- Projet Supabase : `smwrpejnegtssmtmnecb`

## Architecture

- `supabase/migrations/` : schéma privé `heritier`, données initiales, RLS,
  index et tâches `pg_cron`.
- `supabase/functions/heritier-api/` : API compatible avec le client web.
- Supabase Auth : inscription, connexion, confirmation d’adresse et récupération
  de mot de passe.
- `src/`, `prisma/`, `tests/` et les anciens scripts Node : archive de l’API
  historique, conservée pour traçabilité et récupération de données. Elle n’est
  plus déployée.

Les tables de jeu ne sont pas exposées directement à la Data API. L’Edge
Function valide chaque jeton Supabase Auth et accède au schéma privé avec les
droits serveur.

## Développement

Avec la CLI Supabase installée :

```bash
supabase link --project-ref smwrpejnegtssmtmnecb
supabase functions serve heritier-api --no-verify-jwt
```

Les variables nécessaires à l’Edge Function sont fournies automatiquement par
Supabase en production. Pour un environnement local, copiez `.env.example` dans
un fichier de secrets non versionné.

## Déploiement

Consultez [DEPLOY.md](./DEPLOY.md). Les changements de base doivent toujours
être ajoutés sous forme de migration versionnée.

Render n’est plus une dépendance d’exécution. L’ancien service et son ancienne
base peuvent rester suspendus temporairement comme archive de sécurité jusqu’à
la fin de la période de conservation choisie.
