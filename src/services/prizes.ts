import { prisma } from "../prisma";
import { sendMail } from "./mailer";

const AMAZON_2025_TYPE = "amazon-gift-card-2025";
const AMAZON_2025_AMOUNT = Number(process.env.PRIZE_AMAZON_2025_AMOUNT || 20);
const GLOBAL_GAME_CODE = process.env.GLOBAL_GAME_CODE || "GLOBAL";

export async function hasAmazon2025Prize(): Promise<boolean> {
  // Accès via le client Prisma généré: modèle Prize disponible
  const existing = await (prisma as any).prize.findFirst({ where: { type: AMAZON_2025_TYPE } }).catch(() => null);
  return !!existing;
}

export async function computeGlobalWinner2025(): Promise<{ playerId: string; nickname: string; netWorth: number } | null> {
  // Cherche la partie globale
  const game = await prisma.game.findUnique({ where: { code: GLOBAL_GAME_CODE } });
  if (!game) return null;
  const player = await prisma.player.findFirst({
    where: { gameId: game.id },
    orderBy: { netWorth: "desc" },
    select: { id: true, nickname: true, netWorth: true },
  });
  if (!player) return null;
  return { playerId: player.id, nickname: player.nickname, netWorth: player.netWorth };
}

export async function awardAmazonGiftCard2025(): Promise<{ awarded: boolean; reason?: string }> {
  const today = new Date();
  // Vérifier la date cible (31/12/2025)
  const target = new Date("2025-12-31T00:00:00-05:00"); // fuseau approximatif (EST)
  if (today.getFullYear() < 2025 || (today < target)) {
    return { awarded: false, reason: "Pas encore la date" };
  }
  // Déjà attribué ?
  if (await hasAmazon2025Prize()) {
    return { awarded: false, reason: "Déjà attribué" };
  }
  const winner = await computeGlobalWinner2025();
  if (!winner) return { awarded: false, reason: "Aucun joueur trouvé" };

  // Email hypothétique: le modèle Player ne contient pas d'email. On laisse winnerEmail vide.
  const notes = `Gagnant ${winner.nickname} netWorth=${winner.netWorth}`;
  const prize = await (prisma as any).prize.create({
    data: {
      type: AMAZON_2025_TYPE,
      amountValue: AMAZON_2025_AMOUNT,
      currency: "CAD",
      awardedAt: new Date(),
  winnerId: winner.playerId,
      winnerEmail: null,
      gameId: null,
      notes,
    } as any,
  });

  // Tentative d'envoi email seulement si on a une variable ADMIN_EMAIL pour notification interne
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    try {
      await sendMail({
        to: adminEmail,
        subject: "🏆 Prix Amazon 20$ attribué (2025)",
        html: `<p>Le prix Amazon 20$ (2025) a été attribué à <strong>${winner.nickname}</strong> (netWorth=${winner.netWorth.toLocaleString()}).</p><p>ID prize: ${prize.id}</p>`,
      });
    } catch (e) {
      console.error("[prize] Envoi mail admin échoué", e);
    }
  }

  return { awarded: true };
}

export async function checkAndAwardAmazon2025(): Promise<void> {
  try {
    const res = await awardAmazonGiftCard2025();
    if (res.awarded) {
      console.log("[prize] Amazon 2025 attribué");
    } else {
      console.log("[prize] Amazon 2025 non attribué:", res.reason);
    }
  } catch (e) {
    console.error("[prize] Erreur attribution Amazon 2025", e);
  }
}
