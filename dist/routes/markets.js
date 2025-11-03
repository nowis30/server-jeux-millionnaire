"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMarketRoutes = registerMarketRoutes;
const zod_1 = require("zod");
const market_1 = require("../services/market");
const util_1 = require("./util");
async function registerMarketRoutes(app) {
    app.get("/api/games/:gameId/markets/latest", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string() });
        const { gameId } = paramsSchema.parse(req.params);
        const prices = await (0, market_1.latestPricesByGame)(gameId);
        return reply.send({ prices });
    });
    app.get("/api/games/:gameId/markets/holdings/:playerId", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string(), playerId: zod_1.z.string() });
        const { gameId, playerId } = paramsSchema.parse(req.params);
        const holdings = await (0, market_1.holdingsByPlayer)(gameId, playerId);
        return reply.send({ holdings });
    });
    app.post("/api/games/:gameId/markets/buy", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string() });
        const bodySchema = zod_1.z.object({ playerId: zod_1.z.string(), symbol: zod_1.z.string(), quantity: zod_1.z.number().positive() });
        try {
            const { gameId } = paramsSchema.parse(req.params);
            await (0, util_1.assertGameRunning)(app, gameId);
            const body = bodySchema.parse(req.body);
            const trade = await (0, market_1.buyAsset)({ gameId, ...body });
            app.io?.to(`game:${gameId}`).emit("event-feed", {
                type: "market:buy",
                at: new Date().toISOString(),
                gameId,
                playerId: body.playerId,
                symbol: body.symbol,
                quantity: body.quantity,
                price: trade.price,
            });
            return reply.send({ status: "ok", ...trade });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Erreur d'achat d'actif";
            return reply.status(400).send({ error: message });
        }
    });
    app.post("/api/games/:gameId/markets/sell", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string() });
        const bodySchema = zod_1.z.object({ playerId: zod_1.z.string(), symbol: zod_1.z.string(), quantity: zod_1.z.number().positive() });
        try {
            const { gameId } = paramsSchema.parse(req.params);
            await (0, util_1.assertGameRunning)(app, gameId);
            const body = bodySchema.parse(req.body);
            const trade = await (0, market_1.sellAsset)({ gameId, ...body });
            app.io?.to(`game:${gameId}`).emit("event-feed", {
                type: "market:sell",
                at: new Date().toISOString(),
                gameId,
                playerId: body.playerId,
                symbol: body.symbol,
                quantity: body.quantity,
                price: trade.price,
            });
            return reply.send({ status: "ok", ...trade });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Erreur de vente d'actif";
            return reply.status(400).send({ error: message });
        }
    });
}
