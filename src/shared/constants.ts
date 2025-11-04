export const INITIAL_CASH = 1_000_000; // 1 000 000 $

export const ANNUAL_WEEKS = 52;

export const DEFAULT_CRON_TICK = "0 * * * *"; // chaque heure

// Liste d'actifs boursiers (20) avec des ETF/indices/valeurs réelles et effets de levier
// Ordre important: les "drivers" d'abord pour la corrélation dans les ticks quotidiens
export const MARKET_ASSETS = [
	"SP500", // indice S&P 500 (driver)
	"QQQ",   // Nasdaq 100 (driver)
	"TSX",   // indice TSX (driver)
	"GLD",   // or (driver)
	"TLT",   // obligations long terme (driver)
	// Dérivés/corrélés
	"UPRO",  // 3x S&P 500 (levier)
	"TQQQ",  // 3x QQQ (levier)
	"VFV",   // S&P 500 (CAD)
	"VDY",   // ETF dividendes CA (suivi TSX)
	// Grandes capitalisations US (beta vs QQQ/SP500)
	"AAPL",
	"MSFT",
	"AMZN",
	"META",
	"GOOGL",
	"NVDA",
	"TSLA",
		"COST",
	// Secteurs / small caps
	"XLF",   // financières (beta ~ SP500)
	"XLE",   // énergie (plus liée au pétrole mais approximée via SP500)
	"IWM",   // Russell 2000 (beta > SP500)
] as const;

// Condition de victoire (valeur nette cible)
export const WIN_TARGET_NET_WORTH = 10_000_000;

export type MarketSymbol = typeof MARKET_ASSETS[number];
