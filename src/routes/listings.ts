import { FastifyInstance } from "fastify";
import { z } from "zod";
import { listListings, createListing, cancelListing, acceptListing } from "../services/listings";
import { assertGameRunning } from "./util";

export async function registerListingRoutes(app: FastifyInstance) {
  app.get("/api/games/:gameId/listings", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const listings = await listListings(gameId);
    return reply.send({ listings });
  });

  app.post("/api/games/:gameId/listings", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({
      sellerId: z.string(),
      holdingId: z.string().optional(),
      templateId: z.string().optional(),
      price: z.number().positive(),
      type: z.string().optional(),
    }).refine((b) => b.holdingId || b.templateId, { message: "holdingId ou templateId requis" });

    try {
      const { gameId } = paramsSchema.parse((req as any).params);
  const body = bodySchema.parse((req as any).body);
  await assertGameRunning(app, gameId);
      const listing = await createListing({ gameId, ...body });
      (app as any).io?.to(`game:${gameId}`).emit("event-feed", {
        type: "listing:create",
        at: new Date().toISOString(),
        gameId,
        listingId: listing.id,
      });
      return reply.status(201).send({ listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de création de listing";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/api/games/:gameId/listings/:id/cancel", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), id: z.string() });
    const bodySchema = z.object({ sellerId: z.string() });
    try {
      const { gameId, id } = paramsSchema.parse((req as any).params);
  const { sellerId } = bodySchema.parse((req as any).body);
  await assertGameRunning(app, gameId);
      await cancelListing(id, sellerId);
      (app as any).io?.to(`game:${gameId}`).emit("event-feed", {
        type: "listing:cancel",
        at: new Date().toISOString(),
        gameId,
        listingId: id,
      });
      return reply.send({ status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur d'annulation de listing";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/api/games/:gameId/listings/:id/accept", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), id: z.string() });
    const bodySchema = z.object({ buyerId: z.string() });
    try {
      const { gameId, id } = paramsSchema.parse((req as any).params);
  const { buyerId } = bodySchema.parse((req as any).body);
  await assertGameRunning(app, gameId);
      const result = await acceptListing(id, buyerId);
      (app as any).io?.to(`game:${gameId}`).emit("event-feed", {
        type: "listing:accept",
        at: new Date().toISOString(),
        gameId,
        listingId: id,
        buyerId,
        price: (result as any)?.price,
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur d'acceptation de listing";
      return reply.status(400).send({ error: message });
    }
  });
}
