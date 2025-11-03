"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.latestPricesByGame = latestPricesByGame;
exports.buyAsset = buyAsset;
exports.sellAsset = sellAsset;
exports.holdingsByPlayer = holdingsByPlayer;
const shared_1 = require("@hm/shared");
const prisma_1 = require("../prisma");
const simulation_1 = require("./simulation");
const property_1 = require("./property");
const VALID_SYMBOLS = new Set(shared_1.MARKET_ASSETS);
function assertSymbol(symbol) {
    if (!VALID_SYMBOLS.has(symbol)) {
        throw new Error("Actif inconnu");
    }
}
async function latestPrice(gameId, symbol) {
    const last = await prisma_1.prisma.marketTick.findFirst({ where: { gameId, symbol }, orderBy: { at: "desc" } });
    return {
        price: last?.price ?? (0, simulation_1.initialMarketPrice)(symbol),
        at: last?.at ?? new Date(),
    };
}
async function latestPricesByGame(gameId) {
    const results = await Promise.all(shared_1.MARKET_ASSETS.map(async (symbol) => {
        const lp = await latestPrice(gameId, symbol);
        return { symbol, price: lp.price, at: lp.at };
    }));
    return results;
}
async function buyAsset({ gameId, playerId, symbol, quantity }) {
    assertSymbol(symbol);
    if (quantity <= 0)
        throw new Error("Quantité invalide");
    const player = await prisma_1.prisma.player.findUnique({ where: { id: playerId } });
    if (!player || player.gameId !== gameId)
        throw new Error("Player introuvable pour cette partie");
    const { price } = await latestPrice(gameId, symbol);
    const cost = price * quantity;
    if (player.cash < cost)
        throw new Error("Cash insuffisant");
    const existing = await prisma_1.prisma.marketHolding.findUnique({
        where: { playerId_gameId_symbol: { playerId, gameId, symbol } },
    });
    const newQuantity = (existing?.quantity ?? 0) + quantity;
    const newAvgPrice = existing ? (existing.quantity * existing.avgPrice + cost) / newQuantity : price;
    await prisma_1.prisma.$transaction(async (tx) => {
        await tx.player.update({ where: { id: playerId }, data: { cash: { decrement: cost } } });
        await tx.marketHolding.upsert({
            where: { playerId_gameId_symbol: { playerId, gameId, symbol } },
            create: { playerId, gameId, symbol, quantity: newQuantity, avgPrice: newAvgPrice },
            update: { quantity: newQuantity, avgPrice: newAvgPrice },
        });
    });
    await (0, property_1.recalcPlayerNetWorth)(gameId, playerId);
    return { price, cost, quantity: newQuantity };
}
async function sellAsset({ gameId, playerId, symbol, quantity }) {
    assertSymbol(symbol);
    if (quantity <= 0)
        throw new Error("Quantité invalide");
    const holding = await prisma_1.prisma.marketHolding.findUnique({
        where: { playerId_gameId_symbol: { playerId, gameId, symbol } },
    });
    if (!holding || holding.quantity < quantity)
        throw new Error("Position insuffisante");
    const { price } = await latestPrice(gameId, symbol);
    const proceeds = price * quantity;
    const remaining = holding.quantity - quantity;
    await prisma_1.prisma.$transaction(async (tx) => {
        await tx.player.update({ where: { id: playerId }, data: { cash: { increment: proceeds } } });
        if (remaining <= 0) {
            await tx.marketHolding.delete({ where: { playerId_gameId_symbol: { playerId, gameId, symbol } } });
        }
        else {
            await tx.marketHolding.update({
                where: { playerId_gameId_symbol: { playerId, gameId, symbol } },
                data: { quantity: remaining },
            });
        }
    });
    await (0, property_1.recalcPlayerNetWorth)(gameId, playerId);
    return { price, proceeds, remaining };
}
async function holdingsByPlayer(gameId, playerId) {
    const holdings = await prisma_1.prisma.marketHolding.findMany({ where: { gameId, playerId } });
    return holdings;
}
