import { FastifyInstance } from "fastify";
import { z } from "zod";
import { purchaseProperty, refinanceProperty, sellProperty } from "../services/property";
import { ensurePropertyTypeQuotas, seedTemplatesGenerate } from "../services/seeder";
import { assertGameRunning } from "./util";
import { requireUserOrGuest } from "./auth";

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
      // Récupérer l'index d'inflation courant (si gameId fourni)
      let inflationIndex = 1;
      if (gameId) {
        try {
          const g = await (app.prisma as any).game.findUnique({ where: { id: gameId }, select: { inflationIndex: true } });
          inflationIndex = Number(g?.inflationIndex ?? 1) || 1;
        } catch {}
      }
      const quotas = await ensurePropertyTypeQuotas(5, { priceMultiplier: inflationIndex });

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
        created = await seedTemplatesGenerate(totalNow + needed, { priceMultiplier: inflationIndex });
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
  return reply.send({ ok: true, available, created, total, quotas, inflationIndex });
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

  // Bilan détaillé d'un holding (cashflows cumulés)
  app.get("/api/games/:gameId/properties/bilan/:holdingId", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), holdingId: z.string() });
    try {
      const { gameId, holdingId } = paramsSchema.parse((req as any).params);
      const h = await app.prisma.propertyHolding.findFirst({
        where: { id: holdingId, gameId },
        include: { template: true, refinanceLogs: true },
      });
      if (!h) return reply.status(404).send({ error: "Holding introuvable" });
      const hh: any = h as any;
      const bilan = {
        holdingId: h.id,
        templateName: h.template.name,
        purchasePrice: h.purchasePrice,
        downPayment: hh.downPayment ?? null,
        initialMortgageDebt: hh.initialMortgageDebt ?? null,
        currentMortgageDebt: h.mortgageDebt,
        mortgageRate: h.mortgageRate,
        termYears: (hh.termYears ?? 25),
        weeksElapsed: (hh.weeksElapsed ?? 0),
        currentValue: h.currentValue,
        currentRent: h.currentRent,
        accumulated: {
          rent: (hh.accumulatedRent ?? 0),
          interest: (hh.accumulatedInterestPaid ?? 0),
          taxes: (hh.accumulatedTaxesPaid ?? 0),
          insurance: (hh.accumulatedInsurancePaid ?? 0),
          maintenance: (hh.accumulatedMaintenancePaid ?? 0),
          netCashflow: (hh.accumulatedNetCashflow ?? 0),
        },
  refinanceEvents: h.refinanceLogs.map((r: any) => ({ at: r.at, amount: r.amount, rate: r.rate })),
      };
      return reply.send({ bilan });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur bilan";
      return reply.status(400).send({ error: message });
    }
  });

  // Vue agrégée du portefeuille d'un joueur (totaux + gains cumulés)
  app.get("/api/games/:gameId/players/:playerId/portfolio", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), playerId: z.string() });
    try {
      const { gameId, playerId } = paramsSchema.parse((req as any).params);
      const holdings = await app.prisma.propertyHolding.findMany({ where: { gameId, playerId }, include: { template: true } });
      // Agréger
  let totalValue = 0;
  let totalDebt = 0;
  let weeklyRent = 0;
  let weeklyPayment = 0;
  let weeklyFixed = 0;
      let accumulatedNet = 0;
      for (const h of holdings) {
        totalValue += Number(h.currentValue ?? 0);
        totalDebt += Number(h.mortgageDebt ?? 0);
        weeklyRent += Number(h.currentRent ?? 0);
        weeklyPayment += Number(h.weeklyPayment ?? 0);
        accumulatedNet += Number(h.accumulatedNetCashflow ?? 0);
        const t = h.template as any;
        const maintenanceRaw = Number(t?.maintenance ?? 0) || 0;
        const states = [t?.plumbingState, t?.electricityState, t?.roofState].map((s: any) => String(s || '').toLowerCase());
        let mult = 1.0;
        for (const s of states) {
          if (s.includes('à rénover') || s.includes('a rénover') || s.includes('rénover')) mult = Math.max(mult, 1.5);
          else if (s.includes('moyen')) mult = Math.max(mult, 1.25);
        }
        const maintenanceAdj = maintenanceRaw * mult;
        const taxes = Number(t?.taxes ?? 0) || 0;
        const insurance = Number(t?.insurance ?? 0) || 0;
        weeklyFixed += (taxes + insurance + maintenanceAdj) / 52;
      }

  const monthlyRent = (weeklyRent * 52) / 12;
  const monthlyDebt = (weeklyPayment * 52) / 12;
  const monthlyFixed = (weeklyFixed * 52) / 12;
  const monthlyNet = monthlyRent - monthlyDebt - monthlyFixed;
  const weeklyNet = weeklyRent - weeklyPayment - weeklyFixed;

      const player = await app.prisma.player.findUnique({ where: { id: playerId } });

      return reply.send({
        totals: {
          totalValue,
          totalDebt,
          // Hebdomadaire (tick horaire)
          weeklyRent,
          weeklyDebt: weeklyPayment,
          weeklyFixed,
          weeklyNet,
          // Mensuel (affichage)
          monthlyRent,
          monthlyDebt,
          monthlyFixed,
          monthlyNet,
          accumulatedNet,
          holdingsCount: holdings.length,
        },
        playerGains: {
          cumulativePariGain: player?.cumulativePariGain ?? 0,
          cumulativeQuizGain: player?.cumulativeQuizGain ?? 0,
          cumulativeMarketRealized: player?.cumulativeMarketRealized ?? 0,
          cumulativeMarketDividends: player?.cumulativeMarketDividends ?? 0,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur portefeuille";
      return reply.status(400).send({ error: message });
    }
  });

  // Rembourser (partiellement ou totalement) la dette hypothécaire d'un holding
  app.post("/api/games/:gameId/properties/:holdingId/repay", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string(), holdingId: z.string() });
    const bodySchema = z.object({ amount: z.number().min(0) });
    try {
      const { gameId, holdingId } = paramsSchema.parse((req as any).params);
      await assertGameRunning(app, gameId);
      const { amount } = bodySchema.parse((req as any).body);
      const h = await app.prisma.propertyHolding.findUnique({ where: { id: holdingId }, include: { player: true } });
      if (!h) return reply.status(404).send({ error: "Holding introuvable" });
      // Vérifier que le holding appartient à une partie identique
      if (h.gameId !== gameId) return reply.status(400).send({ error: "Mauvaise partie" });
      // Autorisation: seul le propriétaire du holding peut rembourser
      const user: any = (req as any).user || {};
      const playerIdHeader: string | undefined = (req.headers?.["x-player-id"] as string) || undefined;
      let actorPlayerId: string | null = null;
      if (playerIdHeader) {
        actorPlayerId = playerIdHeader;
      } else if (user.guestId) {
        const p = await app.prisma.player.findFirst({ where: { gameId, guestId: user.guestId }, select: { id: true } });
        actorPlayerId = p?.id ?? null;
      }
      if (!actorPlayerId || actorPlayerId !== h.playerId) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const player = h.player as any;
      if (!player) return reply.status(400).send({ error: "Joueur introuvable" });
      const payer = await app.prisma.player.findUnique({ where: { id: player.id } });
      if (!payer) return reply.status(400).send({ error: "Joueur introuvable" });
      const currentDebt = Number(h.mortgageDebt ?? 0);
      const availableCash = Number(payer.cash ?? 0);
      const toApply = Math.min(amount, availableCash, currentDebt);
      if (toApply <= 0) return reply.status(400).send({ error: "Fonds insuffisants ou dette nulle" });
      // Appliquer le remboursement
      const newDebt = Math.max(0, currentDebt - toApply);
      await app.prisma.$transaction([
        app.prisma.propertyHolding.update({ where: { id: holdingId }, data: { mortgageDebt: newDebt } }),
        app.prisma.player.update({ where: { id: payer.id }, data: { cash: { decrement: toApply } } }),
      ]);
      (app as any).io?.to(`game:${gameId}`).emit("event-feed", {
        type: "property:repay",
        at: new Date().toISOString(),
        gameId,
        holdingId,
        amount: toApply,
        playerId: payer.id,
      });
      const updatedPlayer = await app.prisma.player.findUnique({ where: { id: payer.id } });
      return reply.send({ status: "ok", applied: toApply, newDebt, playerCash: updatedPlayer?.cash ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de remboursement";
      return reply.status(400).send({ error: message });
    }
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
      // Mise de fonds minimale 20% désormais
      downPaymentPercent: z.number().min(0.2).max(1).optional(),
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
