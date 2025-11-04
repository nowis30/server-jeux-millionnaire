import { FastifyInstance } from "fastify";
import { z } from "zod";
import { latestPricesByGame, buyAsset, sellAsset, holdingsByPlayer, getHistory, returnsBySymbol } from "../services/market";
import { MARKET_ASSETS, MarketSymbol } from "../shared/constants";
import { assertGameRunning } from "./util";

export async function registerMarketRoutes(app: FastifyInstance) {
  // Cache mémoire simple (90s) pour lisser la charge des endpoints marchés
  const TTL_MS = 90_000; // ~1,5 minute
  const cacheLatest = new Map<string, { exp: number; data: any }>();
  const cacheReturns = new Map<string, { exp: number; data: any }>();

  app.get("/api/games/:gameId/markets/latest", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const querySchema = z.object({ debug: z.coerce.boolean().optional() });
    try {
      const { gameId } = paramsSchema.parse((req as any).params);
      const { debug } = querySchema.parse((req as any).query ?? {});
      // Cache (bypass si debug=1)
      if (!debug) {
        const hit = cacheLatest.get(gameId);
        if (hit && hit.exp > Date.now()) {
          return reply.send(hit.data);
        }
      }
      const prices = await latestPricesByGame(gameId);
      const payload = { prices };
      cacheLatest.set(gameId, { exp: Date.now() + TTL_MS, data: payload });
      return reply.send(payload);
    } catch (e) {
      const err = e as any;
      const message = err?.message || "Internal error";
      const payload: any = { error: message };
      const { debug } = ((req as any).query ?? {}) as any;
      if (String(debug) === "1" || debug === true) {
        payload.stack = err?.stack;
      }
      return reply.status(500).send(payload);
    }
  });

  app.get("/api/games/:gameId/markets/holdings/:playerId", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), playerId: z.string() });
    const { gameId, playerId } = paramsSchema.parse((req as any).params);
    const holdings = await holdingsByPlayer(gameId, playerId);
    return reply.send({ holdings });
  });

  // Diagnostic: dernier prix pour un seul actif (débug production)
  app.get("/api/games/:gameId/markets/latest-one/:symbol", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), symbol: z.enum(MARKET_ASSETS as unknown as [MarketSymbol, ...MarketSymbol[]]) });
    const { gameId, symbol } = paramsSchema.parse((req as any).params);
    try {
      const data = await (req.server as any).prisma.marketTick.findFirst({ where: { gameId, symbol }, orderBy: { at: "desc" } });
      return reply.send({ symbol, last: data ?? null });
    } catch (e) {
      const err = e as any;
      return reply.status(500).send({ error: err?.message || String(e) });
    }
  });

  // Diagnostic: agrégat latest (compte et premiers éléments)
  app.get("/api/games/:gameId/markets/diag-latest", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    try {
      const prices = await latestPricesByGame(gameId);
      return reply.send({ count: prices.length, sample: prices.slice(0, 3) });
    } catch (e) {
      const err = e as any;
      return reply.status(500).send({ error: err?.message || String(e) });
    }
  });

  // Historique pour graphiques (jusqu’à 50 ans simulés)
  app.get("/api/games/:gameId/markets/history/:symbol", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), symbol: z.enum(MARKET_ASSETS as unknown as [MarketSymbol, ...MarketSymbol[]]) });
    const querySchema = z.object({ years: z.coerce.number().min(1).max(50).optional() });
    const { gameId, symbol } = paramsSchema.parse((req as any).params);
    const { years } = querySchema.parse((req as any).query ?? {});
    const data = await getHistory(gameId, symbol as MarketSymbol, years ?? 50);
    return reply.send({ symbol, data });
  });

  // Rendements par actif (fenêtres: 1h, 1d, 7d, 30d, ytd)
  app.get("/api/games/:gameId/markets/returns", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const querySchema = z.object({ windows: z.string().optional(), debug: z.coerce.boolean().optional() });
    try {
      const { gameId } = paramsSchema.parse((req as any).params);
      const { windows, debug } = querySchema.parse((req as any).query ?? {});
      const ws = (windows?.split(",").filter(Boolean) as any) ?? undefined;
      // Cache clé = gameId + fenêtres
      const key = `${gameId}|${(ws ?? []).join(',')}`;
      if (!debug) {
        const hit = cacheReturns.get(key);
        if (hit && hit.exp > Date.now()) {
          return reply.send(hit.data);
        }
      }
      const data = await returnsBySymbol(gameId, ws);
      cacheReturns.set(key, { exp: Date.now() + TTL_MS, data });
      return reply.send(data);
    } catch (e) {
      const err = e as any;
      const { debug } = ((req as any).query ?? {}) as any;
      // En mode debug, exposer l'erreur en 500 pour investigation
      if (String(debug) === "1" || debug === true) {
        return reply.status(500).send({ error: err?.message || "Internal error", stack: err?.stack });
      }
      // Dégradation gracieuse: retourner un objet vide en 200 pour ne pas bloquer l'UI
      const now = new Date().toISOString();
      return reply.send({ asOf: now, windows: ["1d","7d","30d","ytd"], returns: {} });
    }
  });

  app.post("/api/games/:gameId/markets/buy", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({
      playerId: z.string(),
      symbol: z.enum(MARKET_ASSETS as unknown as [MarketSymbol, ...MarketSymbol[]]),
      quantity: z.number().positive(),
    });
    try {
  const { gameId } = paramsSchema.parse((req as any).params);
  await assertGameRunning(app, gameId);
  const body = bodySchema.parse((req as any).body);
  const trade = await buyAsset({ gameId, playerId: body.playerId, symbol: body.symbol as MarketSymbol, quantity: body.quantity });
      (app as any).io?.to(`game:${gameId}`).emit("event-feed", {
        type: "market:buy",
        at: new Date().toISOString(),
        gameId,
        playerId: body.playerId,
        symbol: body.symbol,
        quantity: body.quantity,
        price: trade.price,
      });
      return reply.send({ status: "ok", ...trade });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur d'achat d'actif";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/api/games/:gameId/markets/sell", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({
      playerId: z.string(),
      symbol: z.enum(MARKET_ASSETS as unknown as [MarketSymbol, ...MarketSymbol[]]),
      quantity: z.number().positive(),
    });
    try {
  const { gameId } = paramsSchema.parse((req as any).params);
  await assertGameRunning(app, gameId);
  const body = bodySchema.parse((req as any).body);
  const trade = await sellAsset({ gameId, playerId: body.playerId, symbol: body.symbol as MarketSymbol, quantity: body.quantity });
      (app as any).io?.to(`game:${gameId}`).emit("event-feed", {
        type: "market:sell",
        at: new Date().toISOString(),
        gameId,
        playerId: body.playerId,
        symbol: body.symbol,
        quantity: body.quantity,
        price: trade.price,
      });
      return reply.send({ status: "ok", ...trade });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de vente d'actif";
      return reply.status(400).send({ error: message });
    }
  });

  // KPI dividendes reçus: 24h / 7j / YTD
  app.get("/api/games/:gameId/markets/dividends/:playerId", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), playerId: z.string() });
    const { gameId, playerId } = paramsSchema.parse((req as any).params);
    const now = new Date();
    const d24h = new Date(now); d24h.setUTCHours(d24h.getUTCHours() - 24);
    const d7d = new Date(now); d7d.setUTCDate(d7d.getUTCDate() - 7);
    const ytd = new Date(now); ytd.setUTCMonth(0, 1); ytd.setUTCHours(0,0,0,0);
    async function sumSince(since: Date) {
      const agg = await (req.server as any).prisma.dividendLog.aggregate({
        _sum: { amount: true },
        where: { gameId, playerId, at: { gte: since } },
      }).catch(() => ({ _sum: { amount: 0 } }));
      return Number(agg?._sum?.amount ?? 0);
    }
    const totals = {
      "24h": await sumSince(d24h),
      "7d": await sumSince(d7d),
      "ytd": await sumSince(ytd),
    } as const;
    return reply.send({ totals, asOf: now.toISOString() });
  });
}
