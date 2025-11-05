import { Prisma } from "@prisma/client";
import { MARKET_ASSETS, MarketSymbol } from "../shared/constants";
import { prisma } from "../prisma";
import { initialMarketPrice } from "./simulation";
import { recalcPlayerNetWorth } from "./property";
import { sendEventFeed } from "../socket";

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
  // Optimisé PostgreSQL: 1 requête avec DISTINCT ON pour prendre le dernier tick par symbole
  const rows = await prisma.$queryRaw<{ symbol: string; price: number; at: Date }[]>`
    SELECT DISTINCT ON ("symbol") "symbol", "price", "at"
    FROM "MarketTick"
    WHERE "gameId" = ${gameId}
    ORDER BY "symbol", "at" DESC
  `;
  const map = new Map<string, { price: number; at: Date }>();
  for (const r of rows) map.set(r.symbol, { price: Number(r.price), at: new Date(r.at) });
  return MARKET_ASSETS.map((symbol) => {
    const hit = map.get(symbol as string);
    if (hit) return { symbol: symbol as MarketSymbol, price: hit.price, at: hit.at };
    const p = initialMarketPrice(symbol);
    return { symbol: symbol as MarketSymbol, price: p, at: new Date() };
  });
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
    // Valeurs nominales de long terme approximatives (50 ans):
    // SP500 ~10%, QQQ ~12%, TSX ~8%, OR ~5%, Oblig. LT ~4%
    case "SP500": return { driftA: 0.10, volA: 0.18 };
    case "QQQ": return { driftA: 0.12, volA: 0.30 };
    case "TSX": return { driftA: 0.08, volA: 0.17 };
    case "GLD": return { driftA: 0.05, volA: 0.16 };
    case "TLT": return { driftA: 0.04, volA: 0.12 }; // obligations long terme
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
  // Agrégation des dividendes par joueur (réduit le bruit d'événements)
  const totals = new Map<string, { amount: number; details: Record<string, number> }>();
  // Pré-calcul des pas (steps) pour les "drivers" afin d'appliquer corrélations/leviers
  const steps: Record<string, number> = {};
  const drivers = new Set<MarketSymbol>(["SP500", "QQQ", "TSX", "GLD", "TLT"] as any);

  // Helper: dernier jour ouvré du mois (UTC)
  function lastBusinessDayOfMonth(d: Date) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    // Aller au 1er du mois suivant puis -1 jour => dernier jour calendrier du mois
    const end = new Date(Date.UTC(y, m + 1, 1));
    end.setUTCDate(end.getUTCDate() - 1);
    // Si week-end, reculer au vendredi
    const wd = end.getUTCDay();
    if (wd === 6) end.setUTCDate(end.getUTCDate() - 1); // samedi -> vendredi
    if (wd === 0) end.setUTCDate(end.getUTCDate() - 2); // dimanche -> vendredi
    end.setUTCHours(0, 0, 0, 0);
    return end;
  }

  // Helper: est-ce le dernier jour ouvré d'un trimestre (mars/juin/sept/déc) ?
  function isQuarterEndBusinessDay(d: Date) {
    const qMonths = new Set([2, 5, 8, 11]); // 0-based: Mar, Jun, Sep, Dec
    const month = d.getUTCMonth();
    if (!qMonths.has(month)) return false;
    const lbd = lastBusinessDayOfMonth(d);
    const dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    dd.setUTCHours(0, 0, 0, 0);
    return dd.getTime() === lbd.getTime();
  }

  for (const symbol of MARKET_ASSETS) {
    const last = await prisma.marketTick.findFirst({ where: { gameId, symbol }, orderBy: { at: "desc" } });
    if (!last) {
      // si historique absent, on le génère et on reprend
      await ensureMarketHistory(gameId, 50);
      continue;
    }
    const nextDate = new Date(last.at);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    // éviter weekend: avancer au lundi si besoin
    if (nextDate.getUTCDay() === 6) nextDate.setUTCDate(nextDate.getUTCDate() + 2);
    if (nextDate.getUTCDay() === 0) nextDate.setUTCDate(nextDate.getUTCDate() + 1);

    let step = 1.0;
    if (drivers.has(symbol as MarketSymbol)) {
      const { driftA, volA } = assetParams(symbol as MarketSymbol);
      const driftD = driftA / 252;
      const volD = volA / Math.sqrt(252);
      // bruit déterministe basé sur dernier timestamp
      step = Math.exp(Math.max(-0.2, Math.min(0.2, driftD + volD * randn(mulberry32(hashString(`${gameId}:${symbol}:${+last.at}`))))));
      steps[symbol] = step;
    } else {
      // Aucun dérivé dans l’univers actuel (5 drivers). Par sécurité, fallback corrélé au SP500.
      const log = (x: number) => Math.log(Math.max(1e-6, x));
      const sp = steps["SP500"] ?? 1.0;
      step = Math.exp(1.0 * log(sp));
      step = Math.max(Math.exp(-0.25), Math.min(Math.exp(0.25), step));
    }

    const nextPrice = Number(Math.max(0.01, last.price * step).toFixed(2));
    await prisma.marketTick.create({ data: { gameId, symbol, price: nextPrice, at: nextDate } });

    // Dividendes trimestriels (versement 4x/an, au dernier jour ouvré des mois 03/06/09/12)
    const dividendYieldA = symbol === "SP500" ? 0.018
      : symbol === "TSX" ? 0.03
      : 0;
    if (dividendYieldA > 0 && isQuarterEndBusinessDay(nextDate)) {
      const holdings = await prisma.marketHolding.findMany({ where: { gameId, symbol } });
      const quarterlyYield = dividendYieldA / 4; // 4 versements par an
      for (const h of holdings) {
        const amount = Number((h.quantity * nextPrice * quarterlyYield).toFixed(2));
        if (amount <= 0) continue;
        await prisma.player.update({ where: { id: h.playerId }, data: { cash: { increment: amount } } });
        // Log DB (pour KPI) — une entrée par joueur et par symbole
        await (prisma as any).dividendLog.create({ data: { gameId, playerId: h.playerId, symbol, amount } });
        // Agréger pour event-feed plus tard
        const row = totals.get(h.playerId) ?? { amount: 0, details: {} };
        row.amount += amount;
        row.details[symbol] = (row.details[symbol] ?? 0) + amount;
        totals.set(h.playerId, row);
      }
    }
  }

  // Émettre un événement agrégé par joueur et recalculer la valeur nette une seule fois par joueur
  for (const [playerId, info] of totals.entries()) {
    sendEventFeed(gameId, {
      type: "market:dividend-agg",
      at: new Date().toISOString(),
      gameId,
      playerId,
      amount: Number(info.amount.toFixed(2)),
      details: info.details,
    });
    await recalcPlayerNetWorth(gameId, playerId);
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

// --- Rendements par actif sur fenêtres de temps ---
// Windows de rendement supportées
// - fenêtres réelles: 1h, 1d, 7d, 30d, ytd
// - fenêtres temps de jeu: g1d (1/7 h), g1w (1 h), g1y (52 h)
export type ReturnWindow = "1h" | "1d" | "7d" | "30d" | "ytd" | "g1d" | "g1w" | "g1y";

function windowStartDate(w: ReturnWindow): Date {
  const now = new Date();
  const d = new Date(now);
  switch (w) {
    case "1h": d.setUTCHours(d.getUTCHours() - 1); break;
    case "1d": d.setUTCDate(d.getUTCDate() - 1); break;
    case "7d": d.setUTCDate(d.getUTCDate() - 7); break;
    case "30d": d.setUTCDate(d.getUTCDate() - 30); break;
    case "ytd": d.setUTCMonth(0, 1); d.setUTCHours(0,0,0,0); break;
    // Fenêtres exprimées en temps de jeu (1 semaine de jeu = 1 heure réelle)
    // g1d = 1 jour de jeu = 1/7 h réelle (~8 min 34 s)
    case "g1d": d.setTime(d.getTime() - Math.round((60 * 60 * 1000) / 7)); break;
    // g1w = 1 semaine de jeu = 1 h réelle
    case "g1w": d.setUTCHours(d.getUTCHours() - 1); break;
    // g1y = 1 an de jeu = 52 h réelles
    case "g1y": d.setUTCHours(d.getUTCHours() - 52); break;
  }
  return d;
}

export async function returnsBySymbol(
  gameId: string,
  windows: ReturnWindow[] = ["1d", "7d", "30d", "ytd"]
) {
  const now = new Date();
  // 1) Dernier prix par symbole (1 requête)
  const lastRows = await prisma.$queryRaw<{ symbol: string; price: number }[]>`
    SELECT DISTINCT ON ("symbol") "symbol", "price"
    FROM "MarketTick"
    WHERE "gameId" = ${gameId}
    ORDER BY "symbol", "at" DESC
  `;
  const lastMap = new Map<string, number>();
  for (const r of lastRows) lastMap.set(r.symbol, Number(r.price));

  // Helper pour une fenêtre: base >= since (1 req) et fallback <= since (1 req)
  async function basePricesSince(since: Date) {
    const gteRows = await prisma.$queryRaw<{ symbol: string; price: number }[]>`
      SELECT DISTINCT ON ("symbol") "symbol", "price"
      FROM "MarketTick"
      WHERE "gameId" = ${gameId} AND "at" >= ${since}
      ORDER BY "symbol", "at" ASC
    `;
    const lteRows = await prisma.$queryRaw<{ symbol: string; price: number }[]>`
      SELECT DISTINCT ON ("symbol") "symbol", "price"
      FROM "MarketTick"
      WHERE "gameId" = ${gameId} AND "at" <= ${since}
      ORDER BY "symbol", "at" DESC
    `;
    const gteMap = new Map<string, number>();
    const lteMap = new Map<string, number>();
    for (const r of gteRows) gteMap.set(r.symbol, Number(r.price));
    for (const r of lteRows) lteMap.set(r.symbol, Number(r.price));
    const base: Record<string, number> = {};
    for (const sym of MARKET_ASSETS as readonly string[]) {
      base[sym] = gteMap.get(sym) ?? lteMap.get(sym) ?? lastMap.get(sym) ?? initialMarketPrice(sym);
    }
    return base;
  }

  const result: Record<MarketSymbol, Record<ReturnWindow, number>> = {} as any;
  // Prépare toutes les bases en 2 requêtes par fenêtre
  const basesByWindow: Record<ReturnWindow, Record<string, number>> = {} as any;
  for (const w of windows) {
    basesByWindow[w] = await basePricesSince(windowStartDate(w));
  }

  for (const symbol of MARKET_ASSETS) {
    const lastPrice = lastMap.get(symbol) ?? initialMarketPrice(symbol);
    const rec: Partial<Record<ReturnWindow, number>> = {};
    for (const w of windows) {
      const base = basesByWindow[w][symbol] ?? lastPrice;
      rec[w] = Number(((lastPrice / base) - 1).toFixed(4)) as any;
    }
    (result as any)[symbol] = rec;
  }

  return { asOf: now.toISOString(), windows, returns: result };
}