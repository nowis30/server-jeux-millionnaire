"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerListingRoutes = registerListingRoutes;
const zod_1 = require("zod");
const listings_1 = require("../services/listings");
const util_1 = require("./util");
async function registerListingRoutes(app) {
    app.get("/api/games/:gameId/listings", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string() });
        const { gameId } = paramsSchema.parse(req.params);
        const listings = await (0, listings_1.listListings)(gameId);
        return reply.send({ listings });
    });
    app.post("/api/games/:gameId/listings", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string() });
        const bodySchema = zod_1.z.object({
            sellerId: zod_1.z.string(),
            holdingId: zod_1.z.string().optional(),
            templateId: zod_1.z.string().optional(),
            price: zod_1.z.number().positive(),
            type: zod_1.z.string().optional(),
        }).refine((b) => b.holdingId || b.templateId, { message: "holdingId ou templateId requis" });
        try {
            const { gameId } = paramsSchema.parse(req.params);
            const body = bodySchema.parse(req.body);
            await (0, util_1.assertGameRunning)(app, gameId);
            const listing = await (0, listings_1.createListing)({ gameId, ...body });
            app.io?.to(`game:${gameId}`).emit("event-feed", {
                type: "listing:create",
                at: new Date().toISOString(),
                gameId,
                listingId: listing.id,
            });
            return reply.status(201).send({ listing });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Erreur de création de listing";
            return reply.status(400).send({ error: message });
        }
    });
    app.post("/api/games/:gameId/listings/:id/cancel", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string(), id: zod_1.z.string() });
        const bodySchema = zod_1.z.object({ sellerId: zod_1.z.string() });
        try {
            const { gameId, id } = paramsSchema.parse(req.params);
            const { sellerId } = bodySchema.parse(req.body);
            await (0, util_1.assertGameRunning)(app, gameId);
            await (0, listings_1.cancelListing)(id, sellerId);
            app.io?.to(`game:${gameId}`).emit("event-feed", {
                type: "listing:cancel",
                at: new Date().toISOString(),
                gameId,
                listingId: id,
            });
            return reply.send({ status: "ok" });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Erreur d'annulation de listing";
            return reply.status(400).send({ error: message });
        }
    });
    app.post("/api/games/:gameId/listings/:id/accept", async (req, reply) => {
        const paramsSchema = zod_1.z.object({ gameId: zod_1.z.string(), id: zod_1.z.string() });
        const bodySchema = zod_1.z.object({ buyerId: zod_1.z.string() });
        try {
            const { gameId, id } = paramsSchema.parse(req.params);
            const { buyerId } = bodySchema.parse(req.body);
            await (0, util_1.assertGameRunning)(app, gameId);
            const result = await (0, listings_1.acceptListing)(id, buyerId);
            app.io?.to(`game:${gameId}`).emit("event-feed", {
                type: "listing:accept",
                at: new Date().toISOString(),
                gameId,
                listingId: id,
                buyerId,
                price: result?.price,
            });
            return reply.send(result);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Erreur d'acceptation de listing";
            return reply.status(400).send({ error: message });
        }
    });
}
