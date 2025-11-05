import { prisma } from "../prisma";

/**
 * Service de gestion des tokens de quiz
 * Les joueurs gagnent 1 token par heure automatiquement
 */

const TOKEN_EARN_INTERVAL_MS = 60 * 60 * 1000; // 1 heure en millisecondes

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

  if (tokensToAdd > 0) {
    // Mettre à jour les tokens et le timestamp
    const newLastTokenEarnedAt = new Date(
      player.lastTokenEarnedAt.getTime() + tokensToAdd * TOKEN_EARN_INTERVAL_MS
    );

    const updated = await prisma.player.update({
      where: { id: playerId },
      data: {
        quizTokens: player.quizTokens + tokensToAdd,
        lastTokenEarnedAt: newLastTokenEarnedAt,
      },
      select: { quizTokens: true },
    });

    console.log(
      `[tokens] Joueur ${playerId} a gagné ${tokensToAdd} token(s). Total: ${updated.quizTokens}`
    );

    return updated.quizTokens;
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
  await prisma.player.update({
    where: { id: playerId },
    data: {
      quizTokens: { increment: 1 },
    },
  });

  console.log(`[tokens] Token remboursé pour joueur ${playerId}`);
}

/**
 * Calcule le temps restant avant le prochain token
 */
export async function getTimeUntilNextToken(playerId: string): Promise<number> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { lastTokenEarnedAt: true },
  });

  if (!player) {
    throw new Error("Joueur non trouvé");
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

      if (tokensToAdd > 0) {
        const newLastTokenEarnedAt = new Date(
          player.lastTokenEarnedAt.getTime() + tokensToAdd * TOKEN_EARN_INTERVAL_MS
        );

        await prisma.player.update({
          where: { id: player.id },
          data: {
            quizTokens: player.quizTokens + tokensToAdd,
            lastTokenEarnedAt: newLastTokenEarnedAt,
          },
        });

        totalTokensDistributed += tokensToAdd;
        playersUpdated++;
      }
    }
  }

  if (playersUpdated > 0) {
    console.log(
      `[cron] Tokens distribués: ${totalTokensDistributed} token(s) pour ${playersUpdated} joueur(s)`
    );
  }
}
