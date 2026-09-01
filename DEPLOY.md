# Déploiement Supabase — Héritier Millionnaire

## Pré-requis

- accès au projet Supabase `smwrpejnegtssmtmnecb` ;
- CLI Supabase récente ;
- dépôt client Vercel configuré avec les variables publiques décrites plus bas.

## 1. Vérifier les sources

```bash
deno check supabase/functions/heritier-api/index.ts
```

## 2. Appliquer les migrations

```bash
supabase link --project-ref smwrpejnegtssmtmnecb
supabase db push
```

Les migrations créent le schéma privé `heritier`, les données initiales et les
tâches suivantes :

| Tâche | Fréquence | Rôle |
|---|---:|---|
| `heritier-market-tick` | 12 minutes | Cours des actifs |
| `heritier-hourly-tick` | chaque heure | Simulation immobilière et dividendes |
| distribution de jetons | 1 minute | Recharge Quiz et Pari |
| nettoyage d’exécution | 10 minutes | Présence et historique transitoire |

## 3. Déployer l’Edge Function

```bash
supabase functions deploy heritier-api --no-verify-jwt
```

`verify_jwt` reste désactivé au niveau de la passerelle parce que `/health` et
quelques catalogues sont publics. Toutes les routes protégées valident néanmoins
le jeton via Supabase Auth dans `authenticate()`.

## 4. Configurer le client Vercel

```env
NEXT_PUBLIC_SUPABASE_URL=https://smwrpejnegtssmtmnecb.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_3-7XDsd5zEd-3rrqr0-xgQ_kk0z3ArR
```

Le client est un export statique Next.js. Il ne doit contenir ni réécriture
`/api` vers Render, ni URL `onrender.com`, ni clé `service_role`.

## 5. Vérifications de production

1. `/health` répond avec `ok: true` et `backend: supabase`.
2. Un compte confirmé peut se connecter et rejoindre la partie `GLOBAL`.
3. L’accueil, l’immobilier, la bourse, le Quiz et le Drag chargent leurs données.
4. Une action d’écriture persiste après rechargement.
5. Les quatre tâches planifiées sont actives dans `cron.job`.
6. Les conseillers Supabase ne signalent aucune alerte de sécurité sur le schéma
   `heritier`.

## Retour arrière

- Edge Function : redéployer une version Git antérieure.
- Base : préférer une migration corrective ; ne pas modifier manuellement une
  migration déjà appliquée.
- Ancienne base Render : la garder suspendue comme archive tant que la migration
  historique n’a pas été formellement clôturée. Elle n’est pas utilisée par la
  production.
