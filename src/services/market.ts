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

// --- Simulation avancée du marché (50 ans + ticks quotidiens) ---

// PRNG déterministe (Mulberry32) pour reproductibilité par (gameId,symbol)
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function randn(rng: () => number) {
  // Box-Muller avec PRNG custom
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Paramètres par actif (drift annuel et volatilité annuelle approximatifs)
function assetParams(symbol: MarketSymbol) {
  switch (symbol) {
    case "SP500": return { driftA: 0.07, volA: 0.18 };
    case "TSX": return { driftA: 0.06, volA: 0.16 };
    case "GOLD": return { driftA: 0.04, volA: 0.15 };
    case "OIL": return { driftA: 0.03, volA: 0.35 };
    default: return { driftA: 0.05, volA: 0.2 } as const;
  }
}

// Génère une série quotidienne (252 jours/an) pour N années, avec régimes bull/bear
export async function ensureMarketHistory(gameId: string, years = 50) {
  for (const symbol of MARKET_ASSETS) {
    const count = await prisma.marketTick.count({ where: { gameId, symbol } });
    if (count > 0) continue; // déjà généré

    const { driftA, volA } = assetParams(symbol as MarketSymbol);
    const daysPerYear = 252;
    const totalDays = years * daysPerYear;
    const startPrice = initialMarketPrice(symbol);
    const rng = mulberry32(hashString(`${gameId}:${symbol}`));

    // Régimes: bull/bear/flat avec durées aléatoires
    const regimes: Array<{ driftD: number; volD: number; len: number }> = [];
    let remaining = totalDays;
    while (remaining > 0) {
      const mode = rng();
      const isBull = mode < 0.55; // 55% bull
      const isBear = !isBull && mode < 0.8; // 25% bear
      const len = Math.max(20, Math.floor(rng() * 250)); // ~1-12 mois de bourse
      const driftD = (driftA / daysPerYear) * (isBull ? 1.2 : isBear ? -0.6 : 0.2);
      const volD = (volA / Math.sqrt(daysPerYear)) * (isBull ? 0.9 : isBear ? 1.4 : 0.7);
      regimes.push({ driftD, volD, len: Math.min(len, remaining) });
      remaining -= len;
    }

    const rows: { gameId: string; symbol: MarketSymbol; price: number; at: Date }[] = [];
    let price = startPrice;
    // Commence il y a `years` ans et avance jusqu’à aujourd’hui
    const start = new Date();
    start.setUTCFullYear(start.getUTCFullYear() - years);
    let t = new Date(start);
    let regimeIndex = 0, inRegime = 0;
    for (let d = 0; d < totalDays; d++) {
      // sauter weekends (approx): 5/7 des jours
      if (t.getUTCDay() === 0 || t.getUTCDay() === 6) {
        t.setUTCDate(t.getUTCDate() + 1);
        d--; // ne pas compter
        continue;
      }
      const regime = regimes[regimeIndex];
      const step = Math.exp(regime.driftD + regime.volD * randn(rng));
      price = Math.max(0.01, price * step);
      rows.push({ gameId, symbol: symbol as MarketSymbol, price: Number(price.toFixed(2)), at: new Date(t) });

      inRegime++;
      if (inRegime >= regime.len && regimeIndex < regimes.length - 1) {
        regimeIndex++;
        inRegime = 0;
      }
      t.setUTCDate(t.getUTCDate() + 1);
    }

    // Insert en batch par tranches (évite dépasser limites)
    const chunk = 2000;
    for (let i = 0; i < rows.length; i += chunk) {
      await prisma.marketTick.createMany({ data: rows.slice(i, i + chunk) });
    }
  }
}

export async function dailyMarketTick(gameId: string) {
  // Avance d'un "jour de bourse" en ajoutant le jour suivant basé sur la dernière valeur
  for (const symbol of MARKET_ASSETS) {
    const last = await prisma.marketTick.findFirst({ where: { gameId, symbol }, orderBy: { at: "desc" } });
    if (!last) {
      // si historique absent, on le génère et on reprend
      await ensureMarketHistory(gameId, 50);
      continue;
    }
    const { driftA, volA } = assetParams(symbol as MarketSymbol);
    const driftD = driftA / 252;
    const volD = volA / Math.sqrt(252);
    // petit clamp pour éviter sauts extrêmes
    const step = Math.exp(Math.max(-0.2, Math.min(0.2, driftD + volD * randn(mulberry32(hashString(`${gameId}:${symbol}:${+last.at}`))))));
    const nextPrice = Number(Math.max(0.01, last.price * step).toFixed(2));
    const nextDate = new Date(last.at);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    // éviter weekend: avancer au lundi si besoin
    if (nextDate.getUTCDay() === 6) nextDate.setUTCDate(nextDate.getUTCDate() + 2);
    if (nextDate.getUTCDay() === 0) nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    await prisma.marketTick.create({ data: { gameId, symbol, price: nextPrice, at: nextDate } });
  }
}

export async function getHistory(gameId: string, symbol: MarketSymbol, years = 50) {
  const since = new Date();
  since.setUTCFullYear(since.getUTCFullYear() - years);
  const rows = await prisma.marketTick.findMany({
    where: { gameId, symbol, at: { gte: since } },
    orderBy: { at: "asc" },
    take: years * 400, // garde marge
  });
  return rows.map((r: { at: Date; price: number }) => ({ at: r.at, price: r.price }));
}