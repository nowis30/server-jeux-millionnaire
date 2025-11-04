export const INITIAL_CASH = 1_000_000; // 1 000 000 $

export const ANNUAL_WEEKS = 52;

export const DEFAULT_CRON_TICK = "0 * * * *"; // chaque heure

// Univers réduit: 10 ETFs/indices pour alléger la charge
// Ordre important: "drivers" d'abord pour les corrélations
export const MARKET_ASSETS = [
	"SP500", // driver
	"QQQ",   // driver
	"TSX",   // driver
	"GLD",   // driver
	"TLT",   // driver
	"UPRO",  // 3x SP500
	"TQQQ",  // 3x QQQ
	"VFV",   // S&P500 CAD
	"VDY",   // Dividendes CA
	"IWM",   // Russell 2000
] as const;

// Condition de victoire (valeur nette cible)
export const WIN_TARGET_NET_WORTH = 10_000_000;

export type MarketSymbol = typeof MARKET_ASSETS[number];
