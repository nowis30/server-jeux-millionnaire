"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hourlyTick = hourlyTick;
exports.annualUpdate = annualUpdate;
exports.nightlyRefresh = nightlyRefresh;
exports.initialMarketPrice = initialMarketPrice;
exports.computeWeeklyMortgage = computeWeeklyMortgage;
exports.checkAndMaybeEndGame = checkAndMaybeEndGame;
const prisma_1 = require("../prisma");
const shared_1 = require("@hm/shared");
// Helpers
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
// Calcule de paiement hypothécaire hebdomadaire (amortissement 25 ans par défaut)
function weeklyMortgagePayment(principal, annualRate, years = 25) {
    const weeks = years * shared_1.ANNUAL_WEEKS;
    const weeklyRate = annualRate / shared_1.ANNUAL_WEEKS;
    if (weeklyRate === 0)
        return principal / weeks;
    return (principal * weeklyRate) / (1 - Math.pow(1 + weeklyRate, -weeks));
}
async function hourlyTick(gameId) {
    // 1 tick = 1 semaine
    const game = await prisma_1.prisma.game.findUnique({
        where: { id: gameId },
        include: {
            players: {
                include: { properties: { include: { template: true } }, markets: true },
            },
        },
    });
    if (!game)
        return;
    // Marché: variation des actifs
    for (const symbol of shared_1.MARKET_ASSETS) {
        const last = await prisma_1.prisma.marketTick.findFirst({
            where: { gameId, symbol },
            orderBy: { at: "desc" },
        });
        const base = last?.price ?? initialMarketPrice(symbol);
        const drift = avgWeeklyReturn(symbol);
        const vol = weeklyVolatility(symbol);
        const shock = randn_bm() * vol; // bruit
        const next = clamp(base * (1 + drift + shock), base * 0.8, base * 1.2);
        await prisma_1.prisma.marketTick.create({ data: { gameId, symbol, price: next } });
    }
    // Immobilier et cashflows
    for (const p of game.players) {
        // loyers - dépenses - paiements hypothécaires + rendements de marché
        let delta = 0;
        for (const h of p.properties) {
            const rent = h.currentRent;
            const expenses = (h.weeklyPayment ?? 0) + (h.template.taxes + h.template.insurance + h.template.maintenance) / shared_1.ANNUAL_WEEKS;
            delta += rent - expenses;
        }
        // Rendements boursiers: variation de la valeur de portefeuille -> ajuster cash proportionnellement (simplifié)
        for (const mh of p.markets) {
            const last = await prisma_1.prisma.marketTick.findFirst({ where: { gameId, symbol: mh.symbol }, orderBy: { at: "desc" } });
            if (!last)
                continue;
            const marketValue = mh.quantity * last.price;
            const pnl = marketValue - mh.quantity * mh.avgPrice;
            // n'ajuste pas la quantité; seulement mettre à jour la valeur nette via netWorth recalculé plus bas
            delta += 0; // pas de cash réalisé automatiquement
        }
        await prisma_1.prisma.player.update({ where: { id: p.id }, data: { cash: p.cash + delta } });
    }
    // Recalcul netWorth basique: cash + valeur propriétés + valeur marchés
    const players = await prisma_1.prisma.player.findMany({
        where: { gameId },
        include: { properties: true, markets: true },
    });
    for (const p of players) {
        let net = p.cash;
        for (const h of p.properties)
            net += h.currentValue - h.mortgageDebt;
        for (const mh of p.markets) {
            const last = await prisma_1.prisma.marketTick.findFirst({ where: { gameId, symbol: mh.symbol }, orderBy: { at: "desc" } });
            if (last)
                net += mh.quantity * last.price;
        }
        await prisma_1.prisma.player.update({ where: { id: p.id }, data: { netWorth: net } });
    }
}
async function annualUpdate(gameId) {
    // Appréciation immobilière et inflation loyers/dépenses
    const holdings = await prisma_1.prisma.propertyHolding.findMany({ where: { gameId }, include: { template: true } });
    for (const h of holdings) {
        const appreciation = 0.02 + randn_bm() * 0.03; // ~2% +/- 3%
        const newValue = Math.max(0, h.currentValue * (1 + appreciation));
        const inflation = 0.02 + randn_bm() * 0.01;
        const newRent = Math.max(0, h.currentRent * (1 + inflation));
        await prisma_1.prisma.propertyHolding.update({ where: { id: h.id }, data: { currentValue: newValue, currentRent: newRent } });
    }
}
async function nightlyRefresh(gameId) {
    // Événements de maintenance/réparations/bonus sur les propriétés
    const holdings = await prisma_1.prisma.propertyHolding.findMany({
        where: { gameId },
        include: { player: true },
    });
    for (const h of holdings) {
        const r = Math.random();
        if (r < 0.05) {
            // petite panne
            const cost = Math.round(200 + Math.random() * 800); // 200-1000
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.repairEvent.create({
                    data: { holdingId: h.id, type: "minor_break", cost, impact: "basic fix" },
                }),
                prisma_1.prisma.player.update({ where: { id: h.playerId }, data: { cash: h.player.cash - cost } }),
            ]);
        }
        else if (r < 0.07) {
            // grosse panne
            const cost = Math.round(3000 + Math.random() * 7000); // 3k-10k
            const newValue = Math.max(0, h.currentValue - cost * 0.5);
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.repairEvent.create({
                    data: { holdingId: h.id, type: "major_break", cost, impact: "value reduced" },
                }),
                prisma_1.prisma.propertyHolding.update({ where: { id: h.id }, data: { currentValue: newValue } }),
                prisma_1.prisma.player.update({ where: { id: h.playerId }, data: { cash: h.player.cash - cost } }),
            ]);
        }
        else if (r < 0.08) {
            // rénovation (investissement qui améliore valeur et loyer)
            const cost = Math.round(2000 + Math.random() * 6000); // 2k-8k
            const valueBoost = cost * (0.5 + Math.random() * 0.3); // 50-80% du coût
            const rentBoost = 0.05 + Math.random() * 0.1; // +5% à +15%
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.repairEvent.create({
                    data: { holdingId: h.id, type: "renovation", cost, impact: `value +${Math.round(valueBoost)}, rent +${Math.round(rentBoost * 100)}%` },
                }),
                prisma_1.prisma.propertyHolding.update({ where: { id: h.id }, data: { currentValue: h.currentValue + valueBoost, currentRent: h.currentRent * (1 + rentBoost) } }),
                prisma_1.prisma.player.update({ where: { id: h.playerId }, data: { cash: h.player.cash - cost } }),
            ]);
        }
        else if (r < 0.09) {
            // bonus (subvention/assurance) -> cash positif
            const bonus = Math.round(500 + Math.random() * 1500); // 500-2000
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.repairEvent.create({
                    data: { holdingId: h.id, type: "bonus", cost: -bonus, impact: "insurance or grant" },
                }),
                prisma_1.prisma.player.update({ where: { id: h.playerId }, data: { cash: h.player.cash + bonus } }),
            ]);
        }
    }
    // Après MAJ des propriétés et du cash, recalculer la valeur nette
    const players = await prisma_1.prisma.player.findMany({ where: { gameId }, include: { properties: true, markets: true } });
    for (const p of players) {
        let net = p.cash;
        for (const ph of p.properties)
            net += ph.currentValue - ph.mortgageDebt;
        for (const mh of p.markets) {
            const last = await prisma_1.prisma.marketTick.findFirst({ where: { gameId, symbol: mh.symbol }, orderBy: { at: "desc" } });
            if (last)
                net += mh.quantity * last.price;
        }
        await prisma_1.prisma.player.update({ where: { id: p.id }, data: { netWorth: net } });
    }
}
// --- Utilities marché ---
function initialMarketPrice(symbol) {
    switch (symbol) {
        case "GOLD":
            return 2000;
        case "OIL":
            return 80;
        case "SP500":
            return 5000;
        case "TSX":
            return 21000;
        default:
            return 100;
    }
}
function avgWeeklyReturn(symbol) {
    // approx annuel -> hebdo
    const annual = symbol === "GOLD" ? 0.04 : symbol === "OIL" ? 0.03 : symbol === "SP500" ? 0.07 : symbol === "TSX" ? 0.06 : 0.05;
    return annual / shared_1.ANNUAL_WEEKS;
}
function weeklyVolatility(symbol) {
    const annualVol = symbol === "OIL" ? 0.35 : symbol === "GOLD" ? 0.15 : symbol === "SP500" ? 0.18 : 0.16;
    // approx: vol hebdo ~ vol annuel / sqrt(52)
    return annualVol / Math.sqrt(shared_1.ANNUAL_WEEKS);
}
// Random normal (Box-Muller)
function randn_bm() {
    let u = 0, v = 0;
    while (u === 0)
        u = Math.random();
    while (v === 0)
        v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
function computeWeeklyMortgage(principal, rate) {
    return weeklyMortgagePayment(principal, rate);
}
// Vérifie le seuil de victoire et termine la partie si atteint
async function checkAndMaybeEndGame(gameId) {
    const top = await prisma_1.prisma.player.findFirst({
        where: { gameId },
        orderBy: { netWorth: "desc" },
        select: { id: true, nickname: true, netWorth: true },
    });
    if (!top)
        return { ended: false };
    if ((top.netWorth ?? 0) >= shared_1.WIN_TARGET_NET_WORTH) {
        await prisma_1.prisma.game.update({ where: { id: gameId }, data: { status: "ended" } });
        return { ended: true, winner: top };
    }
    return { ended: false };
}
