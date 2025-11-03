import { Prisma } from "@prisma/client";
import { MARKET_ASSETS, MarketSymbol } from "../shared/constants";
import { prisma } from "../prisma";
import { initialMarketPrice } from "./simulation";
import { recalcPlayerNetWorth } from "./property";

const VALID_SYMBOLS = new Set<MarketSymbol>(MARKET_ASSETS);

function assertSymbol(symbol: string): asserts symbol is MarketSymbol {
  if (!VALID_SYMBOLS.has(symbol as MarketSymbol)) {
    throw new Error("Actif inconnu");
  }
}

async function latestPrice(gameId: string, symbol: MarketSymbol) {
  const last = await prisma.marketTick.findFirst({ where: { gameId, symbol }, orderBy: { at: "desc" } });
  return {
    price: last?.price ?? initialMarketPrice(symbol),
    at: last?.at ?? new Date(),
  };
}

export async function latestPricesByGame(gameId: string) {
  const results = await Promise.all(
    MARKET_ASSETS.map(async (symbol: MarketSymbol) => {
      const lp = await latestPrice(gameId, symbol);
      return { symbol, price: lp.price, at: lp.at };
    })
  );
  return results;
}

interface TradeInput {
  gameId: string;
  playerId: string;
  symbol: MarketSymbol;
  quantity: number;
}

export async function buyAsset({ gameId, playerId, symbol, quantity }: TradeInput) {
  assertSymbol(symbol);
  if (quantity <= 0) throw new Error("Quantité invalide");

  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player || player.gameId !== gameId) throw new Error("Player introuvable pour cette partie");

  const { price } = await latestPrice(gameId, symbol);
  const cost = price * quantity;
  if (player.cash < cost) throw new Error("Cash insuffisant");

  const existing = await prisma.marketHolding.findUnique({
    where: { playerId_gameId_symbol: { playerId, gameId, symbol } },
  });

  const newQuantity = (existing?.quantity ?? 0) + quantity;
  const newAvgPrice = existing ? (existing.quantity * existing.avgPrice + cost) / newQuantity : price;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.player.update({ where: { id: playerId }, data: { cash: { decrement: cost } } });
    await tx.marketHolding.upsert({
      where: { playerId_gameId_symbol: { playerId, gameId, symbol } },
      create: { playerId, gameId, symbol, quantity: newQuantity, avgPrice: newAvgPrice },
      update: { quantity: newQuantity, avgPrice: newAvgPrice },
    });
  });

  await recalcPlayerNetWorth(gameId, playerId);
  return { price, cost, quantity: newQuantity };
}

export async function sellAsset({ gameId, playerId, symbol, quantity }: TradeInput) {
  assertSymbol(symbol);
  if (quantity <= 0) throw new Error("Quantité invalide");

  const holding = await prisma.marketHolding.findUnique({
    where: { playerId_gameId_symbol: { playerId, gameId, symbol } },
  });
  if (!holding || holding.quantity < quantity) throw new Error("Position insuffisante");

  const { price } = await latestPrice(gameId, symbol);
  const proceeds = price * quantity;
  const remaining = holding.quantity - quantity;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.player.update({ where: { id: playerId }, data: { cash: { increment: proceeds } } });
    if (remaining <= 0) {
      await tx.marketHolding.delete({ where: { playerId_gameId_symbol: { playerId, gameId, symbol } } });
    } else {
      await tx.marketHolding.update({
        where: { playerId_gameId_symbol: { playerId, gameId, symbol } },
        data: { quantity: remaining },
      });
    }
  });

  await recalcPlayerNetWorth(gameId, playerId);
  return { price, proceeds, remaining };
}

export async function holdingsByPlayer(gameId: string, playerId: string) {
  const holdings = await prisma.marketHolding.findMany({ where: { gameId, playerId } });
  return holdings;
}