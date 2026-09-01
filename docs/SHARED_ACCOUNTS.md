# Compte unique pour tous les jeux

Supabase Auth est le fournisseur d’identité commun de l’écosystème NOWIS. Un
joueur garde la même adresse, le même mot de passe et la même récupération de
compte d’un jeu à l’autre.

## Intégration web

1. Authentifier l’utilisateur avec l’API Auth du projet
   `smwrpejnegtssmtmnecb`.
2. Stocker la session sous `HM_TOKEN` et `HM_REFRESH_TOKEN`.
3. Envoyer `Authorization: Bearer <HM_TOKEN>` à l’Edge Function concernée.
4. Rafraîchir le jeton avec `grant_type=refresh_token` avant son expiration ou
   après un premier `401`.
5. Ne jamais stocker ni transmettre la clé `service_role` dans un client.

Héritier Millionnaire conserve aussi `gameId` et `playerId` dans `hm-session`.
L’API vérifie que le joueur appartient bien à l’utilisateur authentifié ; le
header `X-Player-ID` n’est donc jamais une preuve d’identité à lui seul.

## Nouveaux jeux et applications natives

- Utiliser le même projet Supabase Auth et les mêmes URL de redirection autorisées.
- Employer la clé publiable côté client.
- Faire passer les opérations privilégiées par une Edge Function ou un serveur
  de confiance.
- Utiliser le flux de récupération Supabase plutôt qu’un mot de passe propre au
  jeu.

L’ancien système de cookies Render (`hm_auth`, `hm_guest`, `hm_csrf`) et les JWT
propriétaires sont archivés. Ils ne doivent pas être intégrés dans de nouveaux
clients.
