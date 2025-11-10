import { prisma } from "../prisma";

// Système de tokens Pari: +5 tokens/heure, max 100, coût 1/token par lancer
const HOUR_MS = 60 * 60 * 1000;
export const PARI_MAX_TOKENS = 100;
export const PARI_TOKENS_PER_HOUR = 5;
// Récompense publicitaire: +20 tokens (plafonné au max)
export const PARI_AD_REWARD = 20;

export async function updatePariTokens(playerId: string): Promise<number> {
  const player = await (prisma as any).player.findUnique({
    where: { id: playerId },
    select: { pariTokens: true, pariTokensUpdatedAt: true },
  });
  if (!player) throw new Error("Joueur non trouvé");
  const now = new Date();
  const last = player.pariTokensUpdatedAt || new Date(0);
  if ((player.pariTokens ?? 0) >= PARI_MAX_TOKENS) {
    return player.pariTokens || 0;
  }
  const elapsed = now.getTime() - last.getTime();
  if (elapsed < HOUR_MS) return player.pariTokens || 0;
  const hours = Math.floor(elapsed / HOUR_MS);
  const toAdd = hours * PARI_TOKENS_PER_HOUR;
  if (toAdd <= 0) return player.pariTokens || 0;
  const next = Math.min(PARI_MAX_TOKENS, (player.pariTokens ?? 0) + toAdd);
  const newLast = new Date(last.getTime() + hours * HOUR_MS);
  const updated = await (prisma as any).player.update({
    where: { id: playerId },
    data: { pariTokens: next, pariTokensUpdatedAt: newLast },
    select: { pariTokens: true },
  });
  return updated.pariTokens;
}

export async function consumePariToken(playerId: string): Promise<boolean> {
  // Mettre à jour avant de consommer
  const current = await updatePariTokens(playerId);
  if ((current ?? 0) <= 0) return false;
  // S'il était au plafond, redémarrer l'horloge en consommant
  const p = await (prisma as any).player.findUnique({ where: { id: playerId }, select: { pariTokens: true } });
  if (!p) throw new Error("Joueur non trouvé");
  const wasAtCap = (p.pariTokens ?? 0) >= PARI_MAX_TOKENS;
  await (prisma as any).player.update({
    where: { id: playerId },
    data: {
      pariTokens: { decrement: 1 },
      ...(wasAtCap ? { pariTokensUpdatedAt: new Date() } : {}),
    } as any,
  });
  return true;
}

export async function getPariSecondsUntilNext(playerId: string): Promise<number> {
  const player = await (prisma as any).player.findUnique({ where: { id: playerId }, select: { pariTokens: true, pariTokensUpdatedAt: true } });
  if (!player) throw new Error("Joueur non trouvé");
  if ((player.pariTokens ?? 0) >= PARI_MAX_TOKENS) return 0;
  const now = new Date();
  const last = player.pariTokensUpdatedAt || new Date(0);
  const elapsed = now.getTime() - last.getTime();
  const remain = Math.max(0, HOUR_MS - (elapsed % HOUR_MS));
  return Math.ceil(remain / 1000);
}
