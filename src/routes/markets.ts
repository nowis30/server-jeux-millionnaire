import { FastifyInstance } from "fastify";
import { z } from "zod";
import { latestPricesByGame, buyAsset, sellAsset, holdingsByPlayer, getHistory, returnsBySymbol } from "../services/market";
import { MARKET_ASSETS, MarketSymbol } from "../shared/constants";
import { assertGameRunning } from "./util";

export async function registerMarketRoutes(app: FastifyInstance) {
  app.get("/api/games/:gameId/markets/latest", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const querySchema = z.object({ debug: z.coerce.boolean().optional() });
    try {
      const { gameId } = paramsSchema.parse((req as any).params);
      const { debug } = querySchema.parse((req as any).query ?? {});
      const prices = await latestPricesByGame(gameId);
      return reply.send({ prices });
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
      const { windows } = querySchema.parse((req as any).query ?? {});
      const ws = (windows?.split(",").filter(Boolean) as any) ?? undefined;
      const data = await returnsBySymbol(gameId, ws);
      return reply.send(data);
    } catch (e) {
      const err = e as any;
      const message = err?.message || "Internal error";
      const payload: any = { error: message };
      const { debug } = ((req as any).query ?? {}) as any;
      if (String(debug) === "1" || debug === true) payload.stack = err?.stack;
      return reply.status(500).send(payload);
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
