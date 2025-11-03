import { prisma } from "../src/prisma";
import { WIN_TARGET_NET_WORTH } from "@hm/shared";
import { checkAndMaybeEndGame } from "../src/services/simulation";

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const code = `E${suffix}`;

  const game = await prisma.game.create({ data: { code, status: "running" } });
  const p1 = await prisma.player.create({ data: { nickname: `p1_${suffix}`, cash: 100000, netWorth: 100000, gameId: game.id, guestId: `guest1_${suffix}` } });
  const p2 = await prisma.player.create({ data: { nickname: `p2_${suffix}`, cash: 100000, netWorth: WIN_TARGET_NET_WORTH + 1000, gameId: game.id, guestId: `guest2_${suffix}` } });

  const check = await checkAndMaybeEndGame(game.id);
  if (!check.ended) throw new Error("Partie non terminée alors que le seuil est atteint");
  if (!check.winner || check.winner.id !== p2.id) throw new Error("Mauvais vainqueur");

  const updated = await prisma.game.findUnique({ where: { id: game.id } });
  if (!updated || updated.status !== "ended") throw new Error("Statut de partie non passé à 'ended'");

  console.log("SMOKE ENDGAME: PASS", { gameId: game.id, winner: check.winner?.nickname });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("SMOKE ENDGAME: FAIL", err);
  process.exit(1);
});
