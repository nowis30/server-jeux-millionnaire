# Projet Supabase commun

Le projet de production commun est `hzyxrubwggcjueqkongh` : Poker Menteur, Village IA et l’Héritier Millionnaire utilisent son Auth, sa base et ses fonctions. Les applications gardent leurs sites et leurs données métier respectifs.

La migration de structure du 11 septembre 2026 est versionnée dans `nowis30/poker-menteur`, sous `supabase/migrations/20260911110056_consolidate_village_project_schema.sql`. Ce dépôt est la référence pour les nouvelles migrations du projet commun. Les anciennes migrations Village et Héritier restent des historiques : ne pas les rejouer intégralement sur la base commune.

Les sauvegardes de données, mots de passe chiffrés, facteurs MFA et secrets ne sont pas dans Git. Les comptes vérifiés présents dans plusieurs applications sont rapprochés sur le compte Poker existant ; les identifiants métier et chemins de fichiers sont remappés. Les anciennes sessions Village/Héritier ne sont pas transférées : une reconnexion est nécessaire. Lorsqu’un compte avait déjà un mot de passe Poker, celui-ci reste le mot de passe commun.

Village appelle `ensure_village_player()` à la première visite d’un utilisateur connecté. Cette opération est idempotente et crée une maison avec une pièce vide. Les inscriptions Poker, notamment anonymes, ne créent pas automatiquement une maison Village.

Configuration publique des applications :

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://hzyxrubwggcjueqkongh.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_03fRORDfOBFt7PO7RcNEEA_zA8_fQbO
```

Les clients Village et Héritier reconnaissent aussi l’ancienne configuration publique de production et utilisent alors le projet commun. Une URL de développement différente conserve sa propre clé. Ces valeurs sont publiques ; aucune clé `service_role` ou secrète ne doit entrer dans un client.

Les fonctions `village-*` et `impostor-game` sont maintenues dans Village-ia, les fonctions `heritier-*` dans server-jeux-millionnaire, et les fonctions Poker dans poker-menteur. Toujours déployer explicitement vers le projet commun. Les clés IA restent côté serveur.

L’ancien projet `smwrpejnegtssmtmnecb` est conservé pour retour arrière. Après la bascule, ne jamais réactiver ses tâches planifiées en parallèle de celles du projet commun, ni y envoyer de nouvelles écritures. Un retour arrière après de nouvelles écritures exige une réconciliation des données, pas seulement un changement d’URL.
