# Build server with monorepo context
FROM node:20-alpine AS base
WORKDIR /app

# Copy root and workspace manifests
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY server/package*.json ./server/

RUN npm ci

# Copy sources
COPY shared ./shared
COPY server ./server

WORKDIR /app/server

ENV NODE_ENV=production

# Generate Prisma client and build
RUN npm run prisma:generate && npm run build

EXPOSE 3001

CMD ["node", "dist/index.js"]
