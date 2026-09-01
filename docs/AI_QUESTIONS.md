# Questions de quiz et IA

Le backend Supabase de production utilise actuellement les questions versionnées
dans `supabase/migrations/20260901_heritier_backend.sql`. Aucune génération de
questions par IA ne s’exécute en production.

Les anciens scripts Node présents dans `src/` et `scripts/` sont conservés comme
archive seulement. Ils ne font pas partie du déploiement Supabase et ne doivent
pas être configurés comme service permanent.

Pour réintroduire une génération automatique, il faudra l’implémenter dans une
Edge Function distincte, stocker sa clé comme secret Supabase et ajouter une
tâche `pg_cron` ou un appel planifié. Cette évolution doit inclure une validation
du format, une déduplication et un budget explicite avant activation.
