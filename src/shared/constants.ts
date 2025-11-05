export const INITIAL_CASH = 1_000_000; // 1 000 000 $

export const ANNUAL_WEEKS = 52;

export const DEFAULT_CRON_TICK = "0 * * * *"; // chaque heure

// Univers réduit à 5 actifs (drivers uniquement) pour accélérer le chargement
// Ordre important: "drivers" d'abord pour les corrélations
export const MARKET_ASSETS = [
	"SP500", // driver
	"QQQ",   // driver
	"TSX",   // driver
	"GLD",   // driver
	"TLT",   // driver
] as const;

// Condition de victoire (valeur nette cible)
export const WIN_TARGET_NET_WORTH = 10_000_000;

export type MarketSymbol = typeof MARKET_ASSETS[number];
