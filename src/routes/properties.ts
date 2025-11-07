import { FastifyInstance } from "fastify";
import { z } from "zod";
import { purchaseProperty, refinanceProperty, sellProperty } from "../services/property";
import { ensurePropertyTypeQuotas, seedTemplatesGenerate } from "../services/seeder";
import { assertGameRunning } from "./util";

export async function registerPropertyRoutes(app: FastifyInstance) {
  app.get("/api/properties/templates", async (req, reply) => {
    // Optionnel: filtrer par gameId pour exclure les templates déjà achetés dans cette partie
    const querySchema = z.object({ gameId: z.string().optional() });
    const { gameId } = querySchema.parse((req as any).query ?? {});

    // Filtre pour exclure uniquement les anciennes photos distantes non désirées
    // On autorise désormais les templates "Immeuble #" (générés) qui utilisent des illustrations locales
    const excludeOld = {
      NOT: { imageUrl: { startsWith: "https://picsum.photos" } },
    } as const;

    if (!gameId) {
      const templates = await app.prisma.propertyTemplate.findMany({ where: excludeOld as any, orderBy: { price: "asc" } });
      return reply.send({ templates });
    }

    const purchased = await app.prisma.propertyHolding.findMany({
      where: { gameId },
      select: { templateId: true },
    });
    const purchasedIds = Array.from(new Set(purchased.map((p: { templateId: string }) => p.templateId)));

    const where = purchasedIds.length
      ? { AND: [excludeOld as any, { id: { notIn: purchasedIds } }] }
      : (excludeOld as any);
    const templates = await app.prisma.propertyTemplate.findMany({ where, orderBy: { price: "asc" } });
    return reply.send({ templates });
  });

  // Remplir/compléter la banque d'immeubles manuellement (bouton client)
  // - Garantit au moins 5 par type (Maison/Duplex/Triplex/6-plex/Tour)
  // - Et un total minimal de 50 templates au global
  app.post("/api/properties/replenish", async (req, reply) => {
    try {
      const body = typeof (req as any).body === 'string' ? JSON.parse((req as any).body) : ((req as any).body || {});
      const gameId: string | undefined = body?.gameId || (req as any).query?.gameId;
      const quotas = await ensurePropertyTypeQuotas(5);

      // Compter les templates DISPONIBLES pour ce jeu (non achetés dans cette partie + pas d'anciennes images picsum)
      const excludeOld = { NOT: { imageUrl: { startsWith: "https://picsum.photos" } } } as const;
      let available = 0;
      if (gameId) {
        const purchased = await app.prisma.propertyHolding.findMany({ where: { gameId }, select: { templateId: true } });
        const purchasedIds = Array.from(new Set(purchased.map((p: any) => p.templateId))).filter(Boolean);
        available = await app.prisma.propertyTemplate.count({ where: purchasedIds.length ? { AND: [excludeOld as any, { id: { notIn: purchasedIds } }] } : (excludeOld as any) });
      } else {
        available = await app.prisma.propertyTemplate.count({ where: excludeOld as any });
      }

      // Si disponibles < 50, générer assez pour atteindre ce seuil de DISPONIBLES
      let created = 0;
      if (available < 50) {
        const totalNow = await app.prisma.propertyTemplate.count();
        const needed = 50 - available;
        created = await seedTemplatesGenerate(totalNow + needed);
        // Recompter après création
        if (gameId) {
          const purchased = await app.prisma.propertyHolding.findMany({ where: { gameId }, select: { templateId: true } });
          const purchasedIds = Array.from(new Set(purchased.map((p: any) => p.templateId))).filter(Boolean);
          available = await app.prisma.propertyTemplate.count({ where: purchasedIds.length ? { AND: [excludeOld as any, { id: { notIn: purchasedIds } }] } : (excludeOld as any) });
        } else {
          available = await app.prisma.propertyTemplate.count({ where: excludeOld as any });
        }
      }

      const total = await app.prisma.propertyTemplate.count();
      return reply.send({ ok: true, available, created, total, quotas });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de remplissage";
      return reply.status(500).send({ error: message });
    }
  });

  // Liste des biens (holdings) d'un joueur dans une partie
  app.get("/api/games/:gameId/properties/holdings/:playerId", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), playerId: z.string() });
    const { gameId, playerId } = paramsSchema.parse((req as any).params);
    const holdings = await app.prisma.propertyHolding.findMany({
      where: { gameId, playerId },
      orderBy: { createdAt: "desc" },
      include: {
        template: true,
        refinanceLogs: { orderBy: { at: "desc" }, take: 10 },
      },
    });
    return reply.send({ holdings });
  });

  // Récupérer le propriétaire (pseudo) d'un template déjà acheté dans une partie
  app.get("/api/games/:gameId/properties/owner/:templateId", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), templateId: z.string() });
    try {
      const { gameId, templateId } = paramsSchema.parse((req as any).params);
      const holding = await app.prisma.propertyHolding.findFirst({
        where: { gameId, templateId },
        select: { playerId: true },
      });
      if (!holding) return reply.send({ ownerNickname: null });
      const player = await app.prisma.player.findUnique({ where: { id: holding.playerId }, select: { nickname: true } });
      return reply.send({ ownerNickname: player?.nickname ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/api/games/:gameId/properties/purchase", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({
      playerId: z.string(),
      templateId: z.string(),
      mortgageRate: z.number().min(0).max(0.15).optional(),
      downPaymentPercent: z.number().min(0).max(1).optional(),
      mortgageYears: z.number().min(5).max(25).optional(),
    });

    try {
  const params = paramsSchema.parse((req as any).params);
  await assertGameRunning(app, params.gameId);
      const body = bodySchema.parse((req as any).body);
  const holding = await purchaseProperty({ gameId: params.gameId, ...body });
      // Emit event feed
      (app as any).io?.to(`game:${params.gameId}`).emit("event-feed", {
        type: "property:purchase",
        at: new Date().toISOString(),
        gameId: params.gameId,
        playerId: body.playerId,
        templateId: body.templateId,
        holdingId: holding.id,
      });
      return reply.status(201).send({ holdingId: holding.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur d'achat";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/api/games/:gameId/properties/:holdingId/refinance", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), holdingId: z.string() });
    const bodySchema = z.object({
      newRate: z.number().min(0).max(0.15),
      cashOutPercent: z.number().min(0).max(1).optional(),
      keepRemainingTerm: z.boolean().optional(),
      newTermYears: z.number().min(5).max(25).optional(),
    });

    try {
  const { gameId, holdingId } = paramsSchema.parse((req as any).params);
  await assertGameRunning(app, gameId);
  const { newRate, cashOutPercent, keepRemainingTerm, newTermYears } = bodySchema.parse((req as any).body);
  await refinanceProperty(holdingId, newRate, cashOutPercent, { keepRemainingTerm, newTermYears });
      (app as any).io?.to(`game:${gameId}`).emit("event-feed", {
        type: "property:refinance",
        at: new Date().toISOString(),
        gameId,
        holdingId,
        newRate,
        cashOutPercent: cashOutPercent ?? null,
      });
      return reply.send({ status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de refinancement";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/api/games/:gameId/properties/:holdingId/sell", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), holdingId: z.string() });
    try {
      const { gameId, holdingId } = paramsSchema.parse((req as any).params);
      await assertGameRunning(app, gameId);
      const proceeds = await sellProperty(holdingId);
      (app as any).io?.to(`game:${gameId}`).emit("event-feed", {
        type: "property:sell",
        at: new Date().toISOString(),
        gameId,
        holdingId,
        proceeds,
      });
      return reply.send({ proceeds });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de vente";
      return reply.status(400).send({ error: message });
    }
  });
}
