# Vérification des récompenses publicitaires

Les recharges Quiz/Pari, la révélation d’une réponse et le bonus nécessitent maintenant un reçu AdMob vérifié côté serveur. Les montants et délais existants restent appliqués. La correction nécessite les changements coordonnés des dépôts serveur, client et Android.

## Parcours

1. Le joueur authentifié demande une intention à `POST /api/games/:id/rewards/intents` avec `kind` (`quiz-token`, `pari-token`, `quiz-reveal`, `bonus`). Une révélation précise aussi `sessionId` et `questionId`.
2. Le serveur lie un identifiant aléatoire au joueur, à l’action et au contexte. Il limite la création à 30 intentions par joueur et par heure, indépendamment de l’interface.
3. Android transmet cet identifiant dans `custom_data` et l’utilisateur Auth dans `user_id`, avant l’affichage de la publicité.
4. Google appelle `GET /api/ads/admob/ssv`. Le serveur vérifie la signature ECDSA avec les clés publiques officielles, l’unité autorisée, l’utilisateur, la transaction unique et les bornes temporelles de l’intention.
5. Le client attend la confirmation et joint `rewardIntentId` à la demande de récompense. Le reçu est consommé dans la même transaction PostgreSQL que le crédit ou la révélation. Un échec du crédit annule aussi sa consommation.

Les tables restent dans le schéma privé `heritier`; `anon` et `authenticated` n’ont aucun accès aux reçus. Une notification signée ne choisit jamais le montant accordé : les règles du jeu le déterminent.

## Préparation avant publication

- Appliquer la migration `20261026153014_heritier_reward_verification.sql` dans une base de validation et exécuter les tests avant toute migration de production.
- Configurer `ADMOB_REWARDED_AD_UNIT_IDS` avec les valeurs exactes du paramètre `ad_unit` autorisées, séparées par des virgules. Pour l’unité native actuellement configurée, la partie numérique est `3604239096`. Vérifier cette valeur dans les callbacks de test AdMob avant activation.
- Déclarer l’URL SSV `https://<projet>.supabase.co/functions/v1/heritier-api/api/ads/admob/ssv` dans AdMob. Conserver la vérification de signature : le callback est public mais ne peut créditer directement un compte.
- Distribuer une version Android qui expose `getRewardVerificationSupport` et transmet les paramètres SSV, puis publier ensemble le client et la fonction. Un ancien APK affiche une demande de mise à jour avant toute nouvelle publicité récompensée.
- Valider sur un appareil un succès, une fermeture avant récompense, un callback retardé, une double demande et une reconnexion. Les clés privées de Google ne sont jamais requises.

Cette branche n’applique aucune migration, ne configure aucun secret ni AdMob, et ne publie pas d’APK. Sans unité autorisée, les nouvelles intentions sont refusées avant l’affichage de la publicité. Les reçus expirent après 30 minutes; prévoir une purge des reçus expirés anciens selon la politique de conservation avant un fort trafic.

## Limites et autres priorités

Les tests locaux utilisent de vraies signatures P-256, PostgreSQL embarqué et une instance PostgreSQL éphémère : huit démarrages Quiz simultanés partagent une seule session et deux demandes de bonus ne créditent qu’une fois. Le schéma complet est appliqué, hors planification pg_cron propre à l’hébergement. Aucun compte de production n’est utilisé. La réception d’un callback réel sur l’hébergement et la compilation complète Android restent des validations de publication. Les résultats de course Drag sont encore déclarés par le client : cette correction ne remplace pas un moteur de course autoritaire côté serveur.

Références : [AdMob SSV](https://developers.google.com/admob/android/ssv), [vérificateur de référence Google/Tink](https://github.com/tink-crypto/tink-java-apps/blob/main/rewardedads/src/main/java/com/google/crypto/tink/apps/rewardedads/RewardedAdsVerifier.java).
