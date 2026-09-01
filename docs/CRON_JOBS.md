# Tâches planifiées Supabase

Les tâches de production sont exécutées dans PostgreSQL par `pg_cron`. Elles
sont créées par `supabase/migrations/20260901_heritier_backend.sql`.

| Tâche | Expression | Fonction SQL | Rôle |
|---|---:|---|---|
| `heritier-market-tick` | `*/12 * * * *` | `heritier.market_tick()` | Met à jour les cours simulés |
| `heritier-hourly-tick` | `7 * * * *` | `heritier.hourly_tick()` | Applique dividendes, loyers et échéances |
| `heritier-token-distribution` | `* * * * *` | `heritier.distribute_tokens()` | Recharge les jetons Quiz et Pari |
| `heritier-runtime-cleanup` | `*/10 * * * *` | `heritier.cleanup_runtime_data()` | Nettoie présence et données transitoires |

## Vérification

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname like 'heritier-%'
order by jobname;

select jobid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid in (
  select jobid from cron.job where jobname like 'heritier-%'
)
order by start_time desc
limit 20;
```

Une modification de fréquence ou de logique doit passer par une nouvelle
migration SQL. Ne modifiez pas une migration déjà appliquée.

La génération de questions par IA de l’ancien serveur n’est pas active. Voir
[AI_QUESTIONS.md](./AI_QUESTIONS.md).
