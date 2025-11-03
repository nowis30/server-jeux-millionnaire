"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.purchaseProperty = purchaseProperty;
exports.refinanceProperty = refinanceProperty;
exports.sellProperty = sellProperty;
exports.recalcPlayerNetWorth = recalcPlayerNetWorth;
const prisma_1 = require("../prisma");
const simulation_1 = require("./simulation");
const DEFAULT_MORTGAGE_RATE = 0.05;
const DEFAULT_DOWN_PAYMENT = 0.2;
async function purchaseProperty({ gameId, playerId, templateId, mortgageRate = DEFAULT_MORTGAGE_RATE, downPaymentPercent = DEFAULT_DOWN_PAYMENT, }) {
    // Empêcher l'achat multiple du même template dans une même partie
    const alreadyOwned = await prisma_1.prisma.propertyHolding.findFirst({ where: { gameId, templateId } });
    if (alreadyOwned)
        throw new Error("Immeuble déjà acheté dans cette partie");
    const [template, player] = await Promise.all([
        prisma_1.prisma.propertyTemplate.findUnique({ where: { id: templateId } }),
        prisma_1.prisma.player.findUnique({ where: { id: playerId } }),
    ]);
    if (!template)
        throw new Error("Property template introuvable");
    if (!player)
        throw new Error("Player introuvable");
    if (player.gameId !== gameId)
        throw new Error("Player n'appartient pas à cette partie");
    const price = template.price;
    const sanitizedPercent = Math.max(0, Math.min(1, downPaymentPercent));
    const downPayment = Math.round(price * sanitizedPercent);
    if (player.cash < downPayment)
        throw new Error("Liquidités insuffisantes");
    const mortgagePrincipal = Math.max(0, price - downPayment);
    const weeklyPayment = mortgagePrincipal > 0 ? (0, simulation_1.computeWeeklyMortgage)(mortgagePrincipal, mortgageRate) : 0;
    const holding = await prisma_1.prisma.$transaction(async (tx) => {
        if (downPayment > 0) {
            await tx.player.update({ where: { id: playerId }, data: { cash: { decrement: downPayment } } });
        }
        return tx.propertyHolding.create({
            data: {
                playerId,
                gameId,
                templateId,
                purchasePrice: price,
                currentValue: price,
                currentRent: template.baseRent,
                mortgageRate,
                mortgageDebt: mortgagePrincipal,
                weeklyPayment,
            },
        });
    });
    await recalcPlayerNetWorth(gameId, playerId);
    return holding;
}
async function refinanceProperty(holdingId, newRate, cashOutPercent = 0.0) {
    const h = await prisma_1.prisma.propertyHolding.findUnique({ where: { id: holdingId } });
    if (!h)
        throw new Error("Holding not found");
    const maxLtv = 0.8; // 80% LTV
    const newDebtCap = h.currentValue * maxLtv;
    const targetDebt = Math.min(newDebtCap, h.mortgageDebt * (1 + cashOutPercent));
    const cashDelta = targetDebt - h.mortgageDebt;
    const weeklyPayment = (0, simulation_1.computeWeeklyMortgage)(targetDebt, newRate);
    await prisma_1.prisma.propertyHolding.update({ where: { id: h.id }, data: { mortgageRate: newRate, mortgageDebt: targetDebt, weeklyPayment } });
    await prisma_1.prisma.refinanceLog.create({ data: { holdingId: h.id, amount: cashDelta, rate: newRate } });
    // ajouter cash au joueur si cash-out
    if (cashDelta > 0) {
        await prisma_1.prisma.player.update({ where: { id: h.playerId }, data: { cash: { increment: cashDelta } } });
    }
    await recalcPlayerNetWorth(h.gameId, h.playerId);
}
async function sellProperty(holdingId) {
    const h = await prisma_1.prisma.propertyHolding.findUnique({ where: { id: holdingId } });
    if (!h)
        throw new Error("Holding not found");
    const proceeds = h.currentValue - h.mortgageDebt;
    await prisma_1.prisma.propertyHolding.delete({ where: { id: holdingId } });
    await prisma_1.prisma.player.update({ where: { id: h.playerId }, data: { cash: { increment: proceeds } } });
    await recalcPlayerNetWorth(h.gameId, h.playerId);
    return proceeds;
}
async function recalcPlayerNetWorth(gameId, playerId) {
    const player = await prisma_1.prisma.player.findUnique({
        where: { id: playerId },
        include: { properties: true, markets: true },
    });
    if (!player)
        return;
    let net = player.cash;
    for (const h of player.properties) {
        net += h.currentValue - h.mortgageDebt;
    }
    for (const holding of player.markets) {
        const last = await prisma_1.prisma.marketTick.findFirst({
            where: { gameId, symbol: holding.symbol },
            orderBy: { at: "desc" },
        });
        const price = last?.price ?? holding.avgPrice;
        net += holding.quantity * price;
    }
    await prisma_1.prisma.player.update({ where: { id: playerId }, data: { netWorth: net } });
}
