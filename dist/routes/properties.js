"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPropertyRoutes = registerPropertyRoutes;
const zod_1 = require("zod");
const property_1 = require("../services/property");
const util_1 = require("./util");
async function registerPropertyRoutes(app) {
    app.get("/api/properties/templates", async (req, reply) => {
        // Optionnel: filtrer par gameId pour exclure les templates déjà achetés dans cette partie
        const querySchema = zod_1.z.object({ gameId: zod_1.z.string().optional() });
        const { gameId } = querySchema.parse(req.query ?? {});
        if (!gameId) {
            const templates = await app.prisma.propertyTemplate.findMany({ orderBy: { price: "asc" } });
            return reply.send({ templates });
        }
        const purchased = await app.prisma.propertyHolding.findMany({
            where: { gameId },
            select: { templateId: true },
        });
        const purchasedIds = Array.from(new Set(purchased.map((p) => p.templateId)));
        const templates = await app.prisma.propertyTemplate.findMany({
            where: purchasedIds.length ? { id: { notIn: purchasedIds } } : {},
            orderBy: { price: "asc" },
        });
        return reply.send({ templates });
    });
    // Liste des biens (holdings) d'un joueur dans une partie
    app.get("/api/games/:gameId/properties/holdings/:playerId", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string(), playerId: zod_1.z.string() });
        const { gameId, playerId } = paramsSchema.parse(req.params);
        const holdings = await app.prisma.propertyHolding.findMany({
            where: { gameId, playerId },
            orderBy: { createdAt: "desc" },
            include: { template: true },
        });
        return reply.send({ holdings });
    });
    app.post("/api/games/:gameId/properties/purchase", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string() });
        const bodySchema = zod_1.z.object({
            playerId: zod_1.z.string(),
            templateId: zod_1.z.string(),
            mortgageRate: zod_1.z.number().min(0).max(0.15).optional(),
            downPaymentPercent: zod_1.z.number().min(0).max(1).optional(),
        });
        try {
            const params = paramsSchema.parse(req.params);
            await (0, util_1.assertGameRunning)(app, params.gameId);
            const body = bodySchema.parse(req.body);
            const holding = await (0, property_1.purchaseProperty)({ gameId: params.gameId, ...body });
            // Emit event feed
            app.io?.to(`game:${params.gameId}`).emit("event-feed", {
                type: "property:purchase",
                at: new Date().toISOString(),
                gameId: params.gameId,
                playerId: body.playerId,
                templateId: body.templateId,
                holdingId: holding.id,
            });
            return reply.status(201).send({ holdingId: holding.id });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Erreur d'achat";
            return reply.status(400).send({ error: message });
        }
    });
    app.post("/api/games/:gameId/properties/:holdingId/refinance", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string(), holdingId: zod_1.z.string() });
        const bodySchema = zod_1.z.object({ newRate: zod_1.z.number().min(0).max(0.15), cashOutPercent: zod_1.z.number().min(0).max(1).optional() });
        try {
            const { gameId, holdingId } = paramsSchema.parse(req.params);
            await (0, util_1.assertGameRunning)(app, gameId);
            const { newRate, cashOutPercent } = bodySchema.parse(req.body);
            await (0, property_1.refinanceProperty)(holdingId, newRate, cashOutPercent);
            app.io?.to(`game:${gameId}`).emit("event-feed", {
                type: "property:refinance",
                at: new Date().toISOString(),
                gameId,
                holdingId,
                newRate,
                cashOutPercent: cashOutPercent ?? null,
            });
            return reply.send({ status: "ok" });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Erreur de refinancement";
            return reply.status(400).send({ error: message });
        }
    });
    app.post("/api/games/:gameId/properties/:holdingId/sell", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string(), holdingId: zod_1.z.string() });
        try {
            const { gameId, holdingId } = paramsSchema.parse(req.params);
            await (0, util_1.assertGameRunning)(app, gameId);
            const proceeds = await (0, property_1.sellProperty)(holdingId);
            app.io?.to(`game:${gameId}`).emit("event-feed", {
                type: "property:sell",
                at: new Date().toISOString(),
                gameId,
                holdingId,
                proceeds,
            });
            return reply.send({ proceeds });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Erreur de vente";
            return reply.status(400).send({ error: message });
        }
    });
}
