import { prisma } from "../prisma";
import { MARKET_ASSETS, ANNUAL_WEEKS, WIN_TARGET_NET_WORTH } from "../shared/constants";
import { sendEventFeed } from "../socket";

// Helpers
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Calcule de paiement hypothécaire hebdomadaire (amortissement 25 ans par défaut)
function weeklyMortgagePayment(principal: number, annualRate: number, years = 25) {
  const weeks = years * ANNUAL_WEEKS;
  const weeklyRate = annualRate / ANNUAL_WEEKS;
  if (weeklyRate === 0) return principal / weeks;
  return (principal * weeklyRate) / (1 - Math.pow(1 + weeklyRate, -weeks));
}

export async function hourlyTick(gameId: string) {
  // 1 tick = 1 semaine
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      players: {
        include: { properties: { include: { template: true } }, markets: true },
      },
    },
  });
  if (!game) return;

  // Marché: variation des actifs
  for (const symbol of MARKET_ASSETS) {
    const last = await prisma.marketTick.findFirst({
      where: { gameId, symbol },
      orderBy: { at: "desc" },
    });
  const base = last?.price ?? initialMarketPrice(symbol);
    const drift = avgWeeklyReturn(symbol);
    const vol = weeklyVolatility(symbol);
    const shock = randn_bm() * vol; // bruit
    const next = clamp(base * (1 + drift + shock), base * 0.8, base * 1.2);
    await prisma.marketTick.create({ data: { gameId, symbol, price: next } });
  }

  // Immobilier et cashflows
  for (const p of game.players) {
    // loyers - dépenses - paiements hypothécaires + rendements de marché
    let delta = 0;
    for (const h of p.properties) {
      const rent = h.currentRent;
      const expenses = (h.weeklyPayment ?? 0) + (h.template.taxes + h.template.insurance + h.template.maintenance) / ANNUAL_WEEKS;
      delta += rent - expenses;
    }

    // Rendements boursiers: variation de la valeur de portefeuille -> ajuster cash proportionnellement (simplifié)
    for (const mh of p.markets) {
      const last = await prisma.marketTick.findFirst({ where: { gameId, symbol: mh.symbol }, orderBy: { at: "desc" } });
      if (!last) continue;
      const marketValue = mh.quantity * last.price;
      const pnl = marketValue - mh.quantity * mh.avgPrice;
      // n'ajuste pas la quantité; seulement mettre à jour la valeur nette via netWorth recalculé plus bas
      delta += 0; // pas de cash réalisé automatiquement
    }

    // Appliquer intérêt débiteur en cas de solde négatif (marge à taux majoré)
    const baseRate = Number((game as any).baseMortgageRate ?? 0.05);
    const marginAnnualRate = Math.max(0, baseRate + 0.05);
    const cashAfter = p.cash + delta;
    let interestCharge = 0;
    if (cashAfter < 0) {
      // Intérêt hebdo sur le découvert
      const weeklyRate = marginAnnualRate / ANNUAL_WEEKS;
      interestCharge = Math.abs(cashAfter) * weeklyRate;
      delta -= interestCharge;
      // événement feed (transparence coûts)
      sendEventFeed(gameId, {
        type: "cash:margin-interest",
        at: new Date().toISOString(),
        gameId,
        playerId: p.id,
        amount: interestCharge,
        rate: marginAnnualRate,
      });
    }
    await prisma.player.update({ where: { id: p.id }, data: { cash: p.cash + delta } });
  }

  // Recalcul netWorth basique: cash + valeur propriétés + valeur marchés
  const players = await prisma.player.findMany({
    where: { gameId },
    include: { properties: true, markets: true },
  });

  for (const p of players) {
    let net = p.cash;
    for (const h of p.properties) net += h.currentValue - h.mortgageDebt;
    for (const mh of p.markets) {
      const last = await prisma.marketTick.findFirst({ where: { gameId, symbol: mh.symbol }, orderBy: { at: "desc" } });
      if (last) net += mh.quantity * last.price;
    }
    await prisma.player.update({ where: { id: p.id }, data: { netWorth: net } });
  }
}

export async function annualUpdate(gameId: string) {
  // Appréciation immobilière et inflation loyers/dépenses
  const holdings = await prisma.propertyHolding.findMany({ where: { gameId }, include: { template: true } });
  const g = await (prisma as any).game.findUnique({ where: { id: gameId }, select: { appreciationAnnual: true } });
  const appr = Number(g?.appreciationAnnual ?? 0.03);
  for (const h of holdings) {
    // Appréciation fixée par le jeu pour l'année, dans [2%,5%]
    const newValue = Math.max(0, h.currentValue * (1 + appr));
    // Inflation des loyers plus forte (2.5% à 4.5%) pour améliorer rentabilité dans le temps
    const inflation = 0.025 + randn_bm() * 0.01;
    const newRent = Math.max(0, h.currentRent * (1 + inflation));
    await prisma.propertyHolding.update({ where: { id: h.id }, data: { currentValue: newValue, currentRent: newRent } });
  }
}

export async function nightlyRefresh(gameId: string) {
  // Événements de maintenance/réparations/bonus sur les propriétés
  const holdings = await prisma.propertyHolding.findMany({
    where: { gameId },
    include: { player: true },
  });

  for (const h of holdings) {
    const r = Math.random();
    if (r < 0.05) {
      // petite panne
      const cost = Math.round(200 + Math.random() * 800); // 200-1000
      await prisma.$transaction([
        prisma.repairEvent.create({
          data: { holdingId: h.id, type: "minor_break", cost, impact: "basic fix" },
        }),
        prisma.player.update({ where: { id: h.playerId }, data: { cash: h.player.cash - cost } }),
      ]);
    } else if (r < 0.07) {
      // grosse panne
      const cost = Math.round(3000 + Math.random() * 7000); // 3k-10k
      const newValue = Math.max(0, h.currentValue - cost * 0.5);
      await prisma.$transaction([
        prisma.repairEvent.create({
          data: { holdingId: h.id, type: "major_break", cost, impact: "value reduced" },
        }),
        prisma.propertyHolding.update({ where: { id: h.id }, data: { currentValue: newValue } }),
        prisma.player.update({ where: { id: h.playerId }, data: { cash: h.player.cash - cost } }),
      ]);
    } else if (r < 0.08) {
      // rénovation (investissement qui améliore valeur et loyer)
      const cost = Math.round(2000 + Math.random() * 6000); // 2k-8k
      const valueBoost = cost * (0.5 + Math.random() * 0.3); // 50-80% du coût
      const rentBoost = 0.05 + Math.random() * 0.1; // +5% à +15%
      await prisma.$transaction([
        prisma.repairEvent.create({
          data: { holdingId: h.id, type: "renovation", cost, impact: `value +${Math.round(valueBoost)}, rent +${Math.round(rentBoost * 100)}%` },
        }),
        prisma.propertyHolding.update({ where: { id: h.id }, data: { currentValue: h.currentValue + valueBoost, currentRent: h.currentRent * (1 + rentBoost) } }),
        prisma.player.update({ where: { id: h.playerId }, data: { cash: h.player.cash - cost } }),
      ]);
    } else if (r < 0.09) {
      // bonus (subvention/assurance) -> cash positif
      const bonus = Math.round(500 + Math.random() * 1500); // 500-2000
      await prisma.$transaction([
        prisma.repairEvent.create({
          data: { holdingId: h.id, type: "bonus", cost: -bonus, impact: "insurance or grant" },
        }),
        prisma.player.update({ where: { id: h.playerId }, data: { cash: h.player.cash + bonus } }),
      ]);
    }
  }

  // Après MAJ des propriétés et du cash, recalculer la valeur nette
  const players = await prisma.player.findMany({ where: { gameId }, include: { properties: true, markets: true } });
  for (const p of players) {
    let net = p.cash;
    for (const ph of p.properties) net += ph.currentValue - ph.mortgageDebt;
    for (const mh of p.markets) {
      const last = await prisma.marketTick.findFirst({ where: { gameId, symbol: mh.symbol }, orderBy: { at: "desc" } });
      if (last) net += mh.quantity * last.price;
    }
    await prisma.player.update({ where: { id: p.id }, data: { netWorth: net } });
  }
}

// --- Utilities marché ---
export function initialMarketPrice(symbol: string): number {
  switch (symbol) {
    case "SP500":
      return 5000;
    case "QQQ":
      return 450;
    case "TSX":
      return 21000;
    case "GLD":
      return 190;
    case "TLT":
      return 90;
    case "UPRO":
      return 80;
    case "TQQQ":
      return 60;
    case "VFV":
      return 100;
    case "VDY":
      return 40;
    case "AAPL":
      return 180;
    case "MSFT":
      return 400;
    case "AMZN":
      return 170;
    case "META":
      return 320;
    case "GOOGL":
      return 140;
    case "NVDA":
      return 600;
    case "TSLA":
      return 250;
    case "COST":
      return 550;
    case "XLF":
      return 37;
    case "XLE":
      return 90;
    case "IWM":
      return 200;
    default:
      return 100;
  }
}

function avgWeeklyReturn(symbol: string): number {
  // approx annuel -> hebdo
  const annual =
    symbol === "SP500" ? 0.07
    : symbol === "QQQ" ? 0.09
    : symbol === "TSX" ? 0.06
    : symbol === "GLD" ? 0.04
    : symbol === "TLT" ? 0.03
    : 0.05;
  return annual / ANNUAL_WEEKS;
}

function weeklyVolatility(symbol: string): number {
  const annualVol = symbol === "GLD" ? 0.15
    : symbol === "SP500" ? 0.18
    : symbol === "QQQ" ? 0.25
    : symbol === "TSX" ? 0.16
    : symbol === "TLT" ? 0.12
    : 0.2;
  // approx: vol hebdo ~ vol annuel / sqrt(52)
  return annualVol / Math.sqrt(ANNUAL_WEEKS);
}

// Random normal (Box-Muller)
function randn_bm() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function computeWeeklyMortgage(principal: number, rate: number) {
  return weeklyMortgagePayment(principal, rate);
}

// Vérifie le seuil de victoire et termine la partie si atteint
export async function checkAndMaybeEndGame(gameId: string) {
  const top = await prisma.player.findFirst({
    where: { gameId },
    orderBy: { netWorth: "desc" },
    select: { id: true, nickname: true, netWorth: true },
  });
  if (!top) return { ended: false } as const;
  if ((top.netWorth ?? 0) >= WIN_TARGET_NET_WORTH) {
    await prisma.game.update({ where: { id: gameId }, data: { status: "ended" } });
    return { ended: true, winner: top } as const;
  }
  return { ended: false } as const;
}
