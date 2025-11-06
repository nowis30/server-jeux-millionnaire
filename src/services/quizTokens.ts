import { prisma } from "../prisma";

/**
 * Service de gestion des tokens de quiz
 * Les joueurs gagnent 1 token par heure automatiquement
 */

const TOKEN_EARN_INTERVAL_MS = 60 * 60 * 1000; // 1 heure en millisecondes
const MAX_TOKENS = 20; // Nombre maximum de tokens accumulables

/**
 * Vérifie et ajoute les tokens gagnés pour un joueur
 * Appelé à chaque fois qu'on vérifie le statut du joueur
 */
export async function updatePlayerTokens(playerId: string): Promise<number> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: {
      quizTokens: true,
      lastTokenEarnedAt: true,
    },
  });

  if (!player) {
    throw new Error("Joueur non trouvé");
  }

  const now = new Date();
  const timeSinceLastToken = now.getTime() - player.lastTokenEarnedAt.getTime();
  const tokensToAdd = Math.floor(timeSinceLastToken / TOKEN_EARN_INTERVAL_MS);

  if (tokensToAdd > 0 && player.quizTokens < MAX_TOKENS) {
    // Nombre de tokens réellement ajoutés en respectant le plafond
    const canAdd = Math.min(tokensToAdd, Math.max(0, MAX_TOKENS - player.quizTokens));
    if (canAdd > 0) {
      const newLastTokenEarnedAt = new Date(
        player.lastTokenEarnedAt.getTime() + canAdd * TOKEN_EARN_INTERVAL_MS
      );
      const updated = await prisma.player.update({
        where: { id: playerId },
        data: {
          quizTokens: player.quizTokens + canAdd,
          lastTokenEarnedAt: newLastTokenEarnedAt,
        },
        select: { quizTokens: true },
      });
  
      console.log(
        `[tokens] Joueur ${playerId} a gagné ${canAdd} token(s). Total: ${updated.quizTokens}`
      );
  
      return updated.quizTokens;
    }
  }

  return player.quizTokens;
}

/**
 * Consomme un token pour démarrer une session de quiz
 */
export async function consumeQuizToken(playerId: string): Promise<boolean> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { quizTokens: true },
  });

  if (!player) {
    throw new Error("Joueur non trouvé");
  }

  if (player.quizTokens <= 0) {
    return false; // Pas assez de tokens
  }

  await prisma.player.update({
    where: { id: playerId },
    data: {
      quizTokens: player.quizTokens - 1,
    },
  });

  console.log(`[tokens] Joueur ${playerId} a consommé 1 token. Reste: ${player.quizTokens - 1}`);

  return true;
}

/**
 * Rembourse un token (par exemple si session échoue à démarrer)
 */
export async function refundQuizToken(playerId: string): Promise<void> {
  const current = await prisma.player.findUnique({ where: { id: playerId }, select: { quizTokens: true } });
  if (!current) throw new Error("Joueur non trouvé");
  const next = Math.min(MAX_TOKENS, (current.quizTokens ?? 0) + 1);
  await prisma.player.update({ where: { id: playerId }, data: { quizTokens: next } });

  console.log(`[tokens] Token remboursé pour joueur ${playerId}`);
}

/**
 * Calcule le temps restant avant le prochain token
 */
export async function getTimeUntilNextToken(playerId: string): Promise<number> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { lastTokenEarnedAt: true, quizTokens: true },
  });

  if (!player) {
    throw new Error("Joueur non trouvé");
  }

  if ((player.quizTokens ?? 0) >= MAX_TOKENS) {
    return 0; // Au plafond, pas de compte à rebours utile
  }
  const now = new Date();
  const timeSinceLastToken = now.getTime() - player.lastTokenEarnedAt.getTime();
  const timeUntilNext = TOKEN_EARN_INTERVAL_MS - (timeSinceLastToken % TOKEN_EARN_INTERVAL_MS);

  return Math.ceil(timeUntilNext / 1000); // Retourne en secondes
}

/**
 * Cron job pour vérifier et distribuer les tokens toutes les minutes
 * (vérifie tous les joueurs actifs)
 */
export async function distributeTokensToActivePlayers(): Promise<void> {
  const activeGames = await prisma.game.findMany({
    where: { status: "active" },
    include: {
      players: {
        select: {
          id: true,
          nickname: true,
          quizTokens: true,
          lastTokenEarnedAt: true,
        },
      },
    },
  });

  let totalTokensDistributed = 0;
  let playersUpdated = 0;

  for (const game of activeGames) {
    for (const player of game.players) {
      const now = new Date();
      const timeSinceLastToken = now.getTime() - player.lastTokenEarnedAt.getTime();
      const tokensToAdd = Math.floor(timeSinceLastToken / TOKEN_EARN_INTERVAL_MS);

      if (tokensToAdd > 0 && player.quizTokens < MAX_TOKENS) {
        const canAdd = Math.min(tokensToAdd, Math.max(0, MAX_TOKENS - player.quizTokens));
        if (canAdd > 0) {
          const newLastTokenEarnedAt = new Date(
            player.lastTokenEarnedAt.getTime() + canAdd * TOKEN_EARN_INTERVAL_MS
          );

          await prisma.player.update({
            where: { id: player.id },
            data: {
              quizTokens: player.quizTokens + canAdd,
              lastTokenEarnedAt: newLastTokenEarnedAt,
            },
          });

          totalTokensDistributed += canAdd;
          playersUpdated++;
        }
      }
    }
  }

  if (playersUpdated > 0) {
    console.log(
      `[cron] Tokens distribués: ${totalTokensDistributed} token(s) pour ${playersUpdated} joueur(s)`
    );
  }
}
