import { FastifyInstance } from "fastify";
import { z } from "zod";
import { latestPricesByGame, buyAsset, sellAsset, holdingsByPlayer } from "../services/market";
import { MARKET_ASSETS, MarketSymbol } from "../shared/constants";
import { assertGameRunning } from "./util";

export async function registerMarketRoutes(app: FastifyInstance) {
  app.get("/api/games/:gameId/markets/latest", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const prices = await latestPricesByGame(gameId);
    return reply.send({ prices });
  });

  app.get("/api/games/:gameId/markets/holdings/:playerId", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), playerId: z.string() });
    const { gameId, playerId } = paramsSchema.parse((req as any).params);
    const holdings = await holdingsByPlayer(gameId, playerId);
    return reply.send({ holdings });
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
}
