FROM node:20-bookworm-slim

# Dossier de travail dans le conteneur
WORKDIR /app

## Dépendances runtime
# Sur Debian (glibc), Prisma utilise les binaires OpenSSL 3.0.
# On installe openssl et les certificats CA, puis on nettoie l'index APT.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Installer les dépendances (inclut devDependencies pour la compilation)
COPY package*.json ./
# Utiliser npm install pour générer un lock cohérent en environnement CI
RUN npm install

# Copier le code source du serveur
COPY . .

ENV NODE_ENV=production

# Générer le client Prisma et construire le code TypeScript
RUN npm run prisma:generate && npm run build

EXPOSE 3001

# Exécuter le résolveur puis les migrations avant de démarrer
CMD ["sh", "-c", "node scripts/resolve_failed_migrations.js && npx prisma migrate deploy && node dist/index.js"]
