import { prisma } from "../src/prisma";
import { buyAsset, sellAsset } from "../src/services/market";

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const code = `M${suffix}`;

  const game = await prisma.game.create({ data: { code, status: "running" } });
  const player = await prisma.player.create({ data: { nickname: `trader_${suffix}`, cash: 100000, netWorth: 100000, gameId: game.id, guestId: `guest_t_${suffix}` } });

  // Utiliser un symbole valide du nouvel univers (ex: GLD au lieu de GOLD)
  const buy = await buyAsset({ gameId: game.id, playerId: player.id, symbol: "GLD", quantity: 10 });
  const afterBuy = await prisma.player.findUnique({ where: { id: player.id } });
  if (!afterBuy) throw new Error("Player introuvable après achat");
  if (afterBuy.cash > 100000 - buy.cost + 1) throw new Error("Cash non débité correctement");

  const sell = await sellAsset({ gameId: game.id, playerId: player.id, symbol: "GLD", quantity: 5 });
  const afterSell = await prisma.player.findUnique({ where: { id: player.id } });
  if (!afterSell) throw new Error("Player introuvable après vente");
  if (afterSell.cash < afterBuy.cash + sell.proceeds - 1) throw new Error("Cash non crédité correctement");

  console.log("SMOKE MARKET: PASS", { gameId: game.id });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("SMOKE MARKET: FAIL", err);
  process.exit(1);
});
