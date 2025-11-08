import { prisma } from "../src/prisma";

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const code = `P${suffix}`;
  const game = await prisma.game.create({ data: { code, status: "running" } });
  const player = await prisma.player.create({ data: { nickname: `player_${suffix}`, cash: 2_000_000, netWorth: 2_000_000, gameId: game.id, guestId: `guest_p_${suffix}` } });
  // Créer deux templates + holdings pour tester agrégation
  const tpl1 = await prisma.propertyTemplate.create({ data: { name: `Immeuble A ${suffix}`, city: "VilleA", imageUrl: "x", price: 300000, baseRent: 2500, taxes: 6000, insurance: 1200, maintenance: 4000 } });
  const tpl2 = await prisma.propertyTemplate.create({ data: { name: `Immeuble B ${suffix}`, city: "VilleB", imageUrl: "x", price: 500000, baseRent: 4200, taxes: 9000, insurance: 1800, maintenance: 7000 } });

  await prisma.propertyHolding.create({ data: { playerId: player.id, gameId: game.id, templateId: tpl1.id, purchasePrice: tpl1.price, currentValue: tpl1.price, currentRent: tpl1.baseRent, mortgageRate: 0.05, mortgageDebt: 200000, weeklyPayment: 1000 } });
  await prisma.propertyHolding.create({ data: { playerId: player.id, gameId: game.id, templateId: tpl2.id, purchasePrice: tpl2.price, currentValue: tpl2.price, currentRent: tpl2.baseRent, mortgageRate: 0.05, mortgageDebt: 400000, weeklyPayment: 1800 } });

  // Appeler directement l'agrégation via Prisma (simule logique route)
  const holdings = await prisma.propertyHolding.findMany({ where: { gameId: game.id, playerId: player.id }, include: { template: true } });
  if (holdings.length !== 2) throw new Error("Holdings non créés correctement");
  const totalValue = holdings.reduce((s: number, h: any) => s + Number(h.currentValue), 0);
  if (totalValue < 800000 - 1) throw new Error("Valeur agrégée incorrecte");

  console.log("SMOKE PORTFOLIO: PASS", { gameId: game.id, playerId: player.id, holdings: holdings.length });
}

main().then(() => process.exit(0)).catch((err) => { console.error("SMOKE PORTFOLIO: FAIL", err); process.exit(1); });