# Archive — ancienne génération IA

Ce document décrivait l’ancien générateur Node de questions. Cette procédure est
retirée depuis la migration vers Supabase et n’est plus une procédure de
production.

État actuel :

- les questions sont initialisées par migration SQL ;
- l’Edge Function `heritier-api` sert le quiz ;
- aucune clé OpenAI n’est requise par Héritier Millionnaire ;
- aucun générateur IA n’est planifié.

Voir [AI_QUESTIONS.md](./AI_QUESTIONS.md) pour la marche à suivre avant toute
réintroduction de cette fonctionnalité.
