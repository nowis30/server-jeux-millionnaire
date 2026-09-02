# Banque Quiz V2 — septembre 2026

## État production validé

- Ancienne banque active : 30 questions.
- Nouvelle banque de base : 280 questions révisées, réparties dans 28 catégories.
- Répartition initiale par catégorie : 2 faciles, 3 moyennes, 5 difficiles.
- Les anciennes questions sont archivées (`active=false`) plutôt que supprimées afin de conserver l'historique des sessions et tentatives.
- Audit trigramme après réécriture : 0 paire suspecte aux seuils de production.

## Garde-fous anti-répétition

La base normalise les formulations (casse, accents, ponctuation et mots-outils) puis refuse :

- les doublons normalisés exacts;
- une similarité globale >= 0,78;
- une similarité >= 0,58 à l'intérieur d'une même catégorie;
- les QCM sans quatre réponses distinctes;
- les questions actives avec une réponse correcte invalide.

Ces règles sont appliquées par `trg_guard_quiz_question_uniqueness`, donc elles couvrent les ajouts manuels et les ajouts IA.

## Fabrique IA

`heritier-quiz-factory` entretient la banque automatiquement. Le modèle par défaut est `gpt-5.6-luna` et peut être remplacé avec `QUIZ_AI_MODEL`.

Pipeline :

1. repérer la catégorie/difficulté la moins fournie;
2. fournir à Luna la liste des concepts déjà présents;
3. générer des QCM qui doivent tester de nouveaux concepts;
4. effectuer une deuxième passe Luna indépendante de vérification factuelle et d'ambiguïté;
5. insérer seulement les candidats approuvés;
6. laisser le trigger PostgreSQL refuser toute formulation encore trop proche.

La fabrique est déclenchée par `pg_cron` toutes les 30 minutes et vise progressivement 20 questions par catégorie et par niveau.

## Sélection en jeu

La version Supabase du quiz doit toujours :

1. préférer une question jamais vue par le joueur dans ses catégories choisies;
2. tenter un remplissage IA si ce stock est épuisé;
3. préférer ensuite une autre question inédite plutôt qu'une répétition;
4. ne reprendre une ancienne question qu'en ultime secours si la banque et la fabrique IA ne peuvent fournir aucun inédit.
