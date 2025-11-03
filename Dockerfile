FROM node:20-alpine

# Dossier de travail dans le conteneur
WORKDIR /app

# Installer les dépendances (inclut devDependencies pour la compilation)
COPY package*.json ./
RUN npm ci

# Copier le code source du serveur
COPY . .

ENV NODE_ENV=production

# Générer le client Prisma et construire le code TypeScript
RUN npm run prisma:generate && npm run build

EXPOSE 3001

CMD ["node", "dist/index.js"]
