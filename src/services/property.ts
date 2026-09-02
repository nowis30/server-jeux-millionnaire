import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { computeWeeklyMortgage } from "./simulation";

interface PurchasePropertyInput {
  gameId: string;
  playerId: string;
  templateId: string;
  mortgageRate?: number; // conservé pour compatibilité API; le taux du marché reste autoritaire
  downPaymentPercent?: number; // ex: 0.2 pour 20%
  mortgageYears?: number; // 5..25 ans
}

const DEFAULT_DOWN_PAYMENT = 0.2;

export async function purchaseProperty({
  gameId,
  playerId,
  templateId,
  downPaymentPercent = DEFAULT_DOWN_PAYMENT,
  mortgageYears,
}: PurchasePropertyInput) {
  const alreadyOwned = await prisma.propertyHolding.findFirst({ where: { gameId, templateId } });
  if (alreadyOwned) {
    const owner = await prisma.player.findUnique({ where: { id: alreadyOwned.playerId }, select: { nickname: true } });
    const ownerName = owner?.nickname ? owner.nickname : "un autre joueur";
    throw new Error(`Immeuble déjà vendu à '${ownerName}'`);
  }

  const [template, player, game] = await Promise.all([
    prisma.propertyTemplate.findUnique({ where: { id: templateId } }),
    prisma.player.findUnique({ where: { id: playerId } }),
    prisma.game.findUnique({ where: { id: gameId }, select: { baseMortgageRate: true } }),
  ]);

  if (!template) throw new Error("Property template introuvable");
  if (!player) throw new Error("Player introuvable");
  if (!game) throw new Error("Partie introuvable");
  if (player.gameId !== gameId) throw new Error("Player n'appartient pas à cette partie");

  const price = template.price;
  const sanitizedPercent = Math.max(0.2, Math.min(1, downPaymentPercent));
  const units = Math.max(1, Number((template as any).units ?? 1));
  const marketRate = Number(game.baseMortgageRate ?? 0.05);
  const downPayment = Math.round(price * sanitizedPercent);
  if (player.cash < downPayment) throw new Error("Liquidités insuffisantes");

  const term = Math.min(25, Math.max(5, Math.round(mortgageYears ?? 25)));
  const mortgagePrincipal = Math.max(0, price - downPayment);
  const weeklyPayment = mortgagePrincipal > 0 ? computeWeeklyMortgage(mortgagePrincipal, marketRate, term) : 0;
  // baseRent est mensuel par unité; currentRent est consommé par le tick hebdomadaire.
  const weeklyRent = (template.baseRent * units * 12) / 52;

  const holding = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (downPayment > 0) {
      await tx.player.update({ where: { id: playerId }, data: { cash: { decrement: downPayment } } });
    }

    return (tx as any).propertyHolding.create({
      data: {
        playerId,
        gameId,
        templateId,
        purchasePrice: price,
        currentValue: price,
        currentRent: weeklyRent,
        mortgageRate: marketRate,
        mortgageDebt: mortgagePrincipal,
        weeklyPayment,
        termYears: term,
        weeksElapsed: 0,
        downPayment,
        initialMortgageDebt: mortgagePrincipal,
      } as any,
    });
  });

  await recalcPlayerNetWorth(gameId, playerId);
  return holding;
}

export async function refinanceProperty(
  holdingId: string,
  _newRate: number,
  cashOutPercent = 0.0,
  opts?: { keepRemainingTerm?: boolean; newTermYears?: number }
) {
  const h = await prisma.propertyHolding.findUnique({ where: { id: holdingId } });
  if (!h) throw new Error("Holding not found");

  const game = await prisma.game.findUnique({ where: { id: h.gameId }, select: { baseMortgageRate: true } });
  if (!game) throw new Error("Partie introuvable");
  const marketRate = Number(game.baseMortgageRate ?? 0.05);

  const maxLtv = 0.8;
  const newDebtCap = h.currentValue * maxLtv;
  const targetDebt = Math.min(newDebtCap, h.mortgageDebt * (1 + cashOutPercent));
  const cashDelta = targetDebt - h.mortgageDebt;
  let termYears = Number((h as any).termYears ?? 25) || 25;
  let weeksElapsed = Number((h as any).weeksElapsed ?? 0) || 0;
  if (opts?.newTermYears != null) {
    termYears = Math.min(25, Math.max(5, Math.round(opts.newTermYears)));
    weeksElapsed = 0;
  }
  const keepRem = opts?.keepRemainingTerm === true && opts?.newTermYears == null;
  const remainingWeeks = keepRem ? Math.max(4, Math.round(termYears * 52 - weeksElapsed)) : Math.round(termYears * 52);
  const weeklyRate = marketRate / 52;
  const weeklyPayment = remainingWeeks > 0
    ? (weeklyRate === 0 ? targetDebt / remainingWeeks : (targetDebt * weeklyRate) / (1 - Math.pow(1 + weeklyRate, -remainingWeeks)))
    : 0;

  await prisma.propertyHolding.update({
    where: { id: h.id },
    data: {
      mortgageRate: marketRate,
      mortgageDebt: targetDebt,
      weeklyPayment,
      termYears,
      weeksElapsed,
    } as any,
  });
  await prisma.refinanceLog.create({ data: { holdingId: h.id, amount: cashDelta, rate: marketRate } });

  if (cashDelta > 0) {
    await prisma.player.update({ where: { id: h.playerId }, data: { cash: { increment: cashDelta } } });
  }

  await recalcPlayerNetWorth(h.gameId, h.playerId);
}

export async function sellProperty(holdingId: string) {
  const h = await prisma.propertyHolding.findUnique({ where: { id: holdingId } });
  if (!h) throw new Error("Holding not found");
  const proceeds = h.currentValue - h.mortgageDebt;
  await prisma.propertyHolding.delete({ where: { id: holdingId } });
  await prisma.player.update({ where: { id: h.playerId }, data: { cash: { increment: proceeds } } });
  await recalcPlayerNetWorth(h.gameId, h.playerId);
  return proceeds;
}

export async function recalcPlayerNetWorth(gameId: string, playerId: string) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { properties: true, markets: true },
  });
  if (!player) return;

  let net = player.cash;
  for (const h of player.properties) {
    net += h.currentValue - h.mortgageDebt;
  }

  for (const holding of player.markets) {
    const last = await prisma.marketTick.findFirst({
      where: { gameId, symbol: holding.symbol },
      orderBy: { at: "desc" },
    });
    const price = last?.price ?? holding.avgPrice;
    net += holding.quantity * price;
  }

  await prisma.player.update({ where: { id: playerId }, data: { netWorth: net } });
}
