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
  // Limiter la pression sur le pool DB: séquentiel (20 requêtes courtes)
  const out: { symbol: MarketSymbol; price: number; at: Date }[] = [];
  for (const symbol of MARKET_ASSETS) {
    const lp = await latestPrice(gameId, symbol as MarketSymbol);
    out.push({ symbol: symbol as MarketSymbol, price: lp.price, at: lp.at });
  }
  return out;
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
    case "QQQ": return { driftA: 0.09, volA: 0.25 };
    case "TSX": return { driftA: 0.06, volA: 0.16 };
    case "GLD": return { driftA: 0.04, volA: 0.15 };
    case "TLT": return { driftA: 0.03, volA: 0.12 }; // obligations long terme
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
      // Dérivés corrélés
      const log = (x: number) => Math.log(Math.max(1e-6, x));
      const n = (s: string) => randn(mulberry32(hashString(`${gameId}:${s}:${+last.at}`)));
      const noiseSmall = 0.02;
      const sp = steps["SP500"] ?? 1.0;
      const nq = steps["QQQ"] ?? 1.0;
      const tx = steps["TSX"] ?? 1.0;

      switch (symbol) {
        case "UPRO": step = Math.exp(3 * log(sp)); break;
        case "TQQQ": step = Math.exp(3 * log(nq)); break;
        case "VFV": step = sp; break;
        case "VDY": step = tx; break;
        case "AAPL": step = Math.exp(1.2 * log(nq) + noiseSmall * n(symbol)); break;
        case "MSFT": step = Math.exp(1.1 * log(nq) + noiseSmall * n(symbol)); break;
        case "AMZN": step = Math.exp(1.3 * log(nq) + noiseSmall * n(symbol)); break;
        case "META": step = Math.exp(1.4 * log(nq) + noiseSmall * n(symbol)); break;
        case "GOOGL": step = Math.exp(1.1 * log(nq) + noiseSmall * n(symbol)); break;
        case "NVDA": step = Math.exp(1.8 * log(nq) + 0.03 * n(symbol)); break;
        case "TSLA": step = Math.exp(1.8 * log(nq) + 0.03 * n(symbol)); break;
        case "COST": step = Math.exp(0.9 * log(sp) + noiseSmall * n(symbol)); break;
        case "XLF": step = Math.exp(1.0 * log(sp) + noiseSmall * n(symbol)); break;
        case "XLE": step = Math.exp(1.0 * log(sp) + 0.02 * n(symbol)); break;
        case "IWM": step = Math.exp(1.2 * log(sp) + 0.025 * n(symbol)); break;
        default: {
          // fallback: utiliser le driver SP500 avec beta 1 et petit bruit
          step = Math.exp(1.0 * log(sp) + 0.02 * n(symbol));
        }
      }
      // clamp de sécurité
      step = Math.max(Math.exp(-0.25), Math.min(Math.exp(0.25), step));
    }

    const nextPrice = Number(Math.max(0.01, last.price * step).toFixed(2));
    await prisma.marketTick.create({ data: { gameId, symbol, price: nextPrice, at: nextDate } });

    // Dividendes quotidiens approximatifs (rendement annuel / 252)
    const dividendYieldA = symbol === "SP500" ? 0.018
      : symbol === "TSX" ? 0.03
      : symbol === "VFV" ? 0.018
      : symbol === "VDY" ? 0.04
      : 0;
    if (dividendYieldA > 0) {
      const holdings = await prisma.marketHolding.findMany({ where: { gameId, symbol } });
      const dailyYield = dividendYieldA / 252;
      for (const h of holdings) {
        const amount = Number((h.quantity * nextPrice * dailyYield).toFixed(2));
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
export type ReturnWindow = "1h" | "1d" | "7d" | "30d" | "ytd";

function windowStartDate(w: ReturnWindow): Date {
  const now = new Date();
  const d = new Date(now);
  switch (w) {
    case "1h": d.setUTCHours(d.getUTCHours() - 1); break;
    case "1d": d.setUTCDate(d.getUTCDate() - 1); break;
    case "7d": d.setUTCDate(d.getUTCDate() - 7); break;
    case "30d": d.setUTCDate(d.getUTCDate() - 30); break;
    case "ytd": d.setUTCMonth(0, 1); d.setUTCHours(0,0,0,0); break;
  }
  return d;
}

export async function returnsBySymbol(
  gameId: string,
  windows: ReturnWindow[] = ["1d", "7d", "30d", "ytd"]
) {
  const now = new Date();
  const result: Record<MarketSymbol, Record<ReturnWindow, number>> = {} as any;

  for (const symbol of MARKET_ASSETS) {
    const wret: Partial<Record<ReturnWindow, number>> = {};
    // Dernier cours (référence de fin)
    const last = await prisma.marketTick.findFirst({ where: { gameId, symbol }, orderBy: { at: "desc" } });
    const lastPrice = last?.price ?? initialMarketPrice(symbol);
    for (const w of windows) {
      const since = windowStartDate(w);
      // Trouver le premier tick à partir de la fenêtre (ou le plus proche précédent si aucun)
      const first = await prisma.marketTick.findFirst({
        where: { gameId, symbol, at: { gte: since } },
        orderBy: { at: "asc" },
      });
      let basePrice = first?.price;
      if (!basePrice) {
        // fallback: prendre le plus récent avant la fenêtre
        const prev = await prisma.marketTick.findFirst({
          where: { gameId, symbol, at: { lte: since } },
          orderBy: { at: "desc" },
        });
        basePrice = prev?.price ?? lastPrice;
      }
      const ret = basePrice ? (lastPrice / basePrice) - 1 : 0;
      wret[w] = Number(ret.toFixed(4)) as any;
    }
    (result as any)[symbol] = wret;
  }

  return { asOf: now.toISOString(), windows, returns: result };
}