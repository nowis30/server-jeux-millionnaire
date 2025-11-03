# Données de seed immobilier

Ce dossier contient le fichier `immeubles_seed.json` utilisé par `prisma/seed.ts` pour importer des gabarits (PropertyTemplate) réels du Québec.

Notes:
- Le seed est idempotent: si un gabarit existe déjà (même `name`), il n'est pas recréé.
- Si le fichier est absent, le script de seed génère automatiquement des gabarits synthétiques pour atteindre un minimum de 50.
- Ne supprimez pas `immeubles_seed.json` du dépôt, sinon les déploiements n'auront plus de données réelles à importer.

Format (extrait):
```json
{
  "id": "IM001",
  "type": "Duplex",
  "ville": "Montréal",
  "photoUrl": "https://…",
  "valeurMarchande": 1100000,
  "revenuAnnuel": 59247,
  "depensesAnnuel": 22818,
  "etat": {"toiture": 89, "plomberie": 73, "electricite": 84, "fenetres": 47, "revetement": 59},
  "renovationsPrevues": "…",
  "capRate": 3.31,
  "vacance": 0.08,
  "anneeConstruction": 1983,
  "latitude": 45.476302,
  "longitude": -73.702446
}
```
