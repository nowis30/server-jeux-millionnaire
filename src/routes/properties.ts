import { FastifyInstance } from "fastify";
import { z } from "zod";
import { purchaseProperty, refinanceProperty, sellProperty } from "../services/property";
import { ensurePropertyTypeQuotas, ensureExactTypeCounts, seedTemplatesGenerate } from "../services/seeder";
import { assertGameRunning } from "./util";
import { requireUserOrGuest } from "./auth";
import { requireAdmin } from "./auth";

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
      // Ensurer explicitement 10 six-plex (units=6) et 10 tours (units=50) si quotas généraux n'ont pas suffi
      const countsNeeded: Record<number, number> = {};
      const sixCount = await app.prisma.propertyTemplate.count({ where: { units: 6 } });
      if (sixCount < 10) countsNeeded[6] = 10;
      const towerCount = await app.prisma.propertyTemplate.count({ where: { units: 50 } });
      if (towerCount < 10) countsNeeded[50] = 10;
      const tower100Count = await app.prisma.propertyTemplate.count({ where: { units: 100 } });
      if (tower100Count < 5) countsNeeded[100] = 5;
      let extraCreated = 0;
      if (Object.keys(countsNeeded).length) {
        const exact = await ensureExactTypeCounts(countsNeeded, { priceMultiplier: inflationIndex });
        extraCreated = Object.values(exact).reduce((s, r) => s + r.created, 0);
      }

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

  // Refill ciblé: assurer exactement 10 six-plex disponibles (units=6) sans toucher les autres types.
  // GET ou POST /api/properties/refill/sixplex10
  async function handleRefillSixplex(req: any, reply: any) {
    try {
      // Compter six-plex existants (tous) puis appliquer ensureExactTypeCounts vers 10 si <10
      const current = await app.prisma.propertyTemplate.count({ where: { units: 6 } });
      if (current < 10) {
        const res = await ensureExactTypeCounts({ 6: 10 });
        return reply.send({ ok: true, before: current, after: 10, created: res[6]?.created ?? 0 });
      }
      return reply.send({ ok: true, before: current, after: current, created: 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur refill six-plex";
      return reply.status(500).send({ error: message });
    }
  }
  app.post("/api/properties/refill/sixplex10", handleRefillSixplex);
  app.get("/api/properties/refill/sixplex10", handleRefillSixplex);

  // Refill ciblé: assurer exactement 10 tours de 50 logements disponibles (units=50) sans toucher les autres types.
  // GET ou POST /api/properties/refill/tower50x10
  async function handleRefillTower50(req: any, reply: any) {
    try {
      const current = await app.prisma.propertyTemplate.count({ where: { units: 50 } });
      if (current < 10) {
        const res = await ensureExactTypeCounts({ 50: 10 });
        return reply.send({ ok: true, before: current, after: 10, created: res[50]?.created ?? 0 });
      }
      return reply.send({ ok: true, before: current, after: current, created: 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur refill tour 50";
      return reply.status(500).send({ error: message });
    }
  }
  app.post("/api/properties/refill/tower50x10", handleRefillTower50);
  app.get("/api/properties/refill/tower50x10", handleRefillTower50);

  // Refill ciblé: assurer exactement 5 tours de 100 logements (units=100)
  // GET ou POST /api/properties/refill/tower100x5
  async function handleRefillTower100(req: any, reply: any) {
    try {
      const current = await app.prisma.propertyTemplate.count({ where: { units: 100 } });
      if (current < 5) {
        const res = await ensureExactTypeCounts({ 100: 5 });
        return reply.send({ ok: true, before: current, after: 5, created: res[100]?.created ?? 0 });
      }
      return reply.send({ ok: true, before: current, after: current, created: 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur refill tour 100";
      return reply.status(500).send({ error: message });
    }
  }
  app.post("/api/properties/refill/tower100x5", handleRefillTower100);
  app.get("/api/properties/refill/tower100x5", handleRefillTower100);

  // Refill incrémental générique: ajoute +10 au stock global d'un type (units param)
  // GET ou POST /api/properties/refill/units/:units/plus10
  async function handleRefillPlus10(req: any, reply: any) {
    try {
      const paramsSchema = z.object({ units: z.coerce.number().min(1) });
      const { units } = paramsSchema.parse((req as any).params);
      // Limiter aux types stratégiques connus pour éviter pollution: 1,2,3,6,50,100
      const allowed = new Set([1,2,3,6,50,100]);
      if (!allowed.has(units)) return reply.status(400).send({ error: "Type non supporté" });
      const current = await app.prisma.propertyTemplate.count({ where: { units } });
      const target = current + 10;
      const res = await ensureExactTypeCounts({ [units]: target });
      return reply.send({ ok: true, before: current, after: target, created: res[units]?.created ?? 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur refill +10";
      return reply.status(500).send({ error: message });
    }
  }
  app.post("/api/properties/refill/units/:units/plus10", handleRefillPlus10);
  app.get("/api/properties/refill/units/:units/plus10", handleRefillPlus10);

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

  // Maintenir automatiquement au moins 5 templates disponibles par type principal (Maison, Duplex, Triplex, 6-plex, Tour à condos)
  // Endpoint: POST /api/games/:gameId/properties/maintain-bank
  // Idée: après une vente ou un achat côté client tu peux l'appeler pour recompléter instantanément
  app.post("/api/games/:gameId/properties/maintain-bank", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    try {
      // Lire inflation index pour ajuster les prix des nouveaux templates
      let inflationIndex = 1;
      try {
        const g = await (app.prisma as any).game.findUnique({ where: { id: gameId }, select: { inflationIndex: true } });
        inflationIndex = Number(g?.inflationIndex ?? 1) || 1;
      } catch {}

      // Récupérer les templates déjà ACHETÉS dans cette partie pour les exclure de la disponibilité
      const purchased = await app.prisma.propertyHolding.findMany({ where: { gameId }, select: { templateId: true } });
      const purchasedIds = new Set(purchased.map(p => p.templateId));

      // Compter la disponibilité par type (basé sur units) excluant les achetés
      async function countAvailable(units: number) {
        return await app.prisma.propertyTemplate.count({ where: purchasedIds.size ? { units, id: { notIn: Array.from(purchasedIds) } } : { units } });
      }
      // Cibles par défaut (peuvent être surchargées via body.targets)
  const desiredDefault = { 1:5, 2:5, 3:5, 6:5, 50:5, 100:5 } as Record<number, number>;
      const body = typeof (req as any).body === 'string' ? JSON.parse((req as any).body) : ((req as any).body || {});
      const incomingTargets = body?.targets as Record<number|string, number> | undefined;
      const desired: Record<number, number> = { ...desiredDefault };
      if (incomingTargets && typeof incomingTargets === 'object') {
        for (const [k,v] of Object.entries(incomingTargets)) {
          const u = Number(k);
          const n = Number(v);
          if (Number.isFinite(u) && Number.isFinite(n) && u > 0 && n >= 0) desired[u] = n;
        }
      }
      const before: Record<string, number> = {};
      const deficits: Record<number, number> = {};
      for (const [uStr, need] of Object.entries(desired)) {
        const u = Number(uStr);
        const avail = await countAvailable(u);
        before[uStr] = avail;
        if (avail < need) deficits[u] = need - avail;
      }

      let createdTotal = 0;
      if (Object.keys(deficits).length) {
        // ensureExactTypeCounts crée jusqu'à atteindre le total cible global (inclut existants). On calcule cible = existants + déficit.
        const targets: Record<number, number> = {};
        for (const [uStr, need] of Object.entries(desired)) {
          const u = Number(uStr);
          const currentGlobal = await app.prisma.propertyTemplate.count({ where: { units: u } });
          const deficitLocal = deficits[u] || 0;
          targets[u] = currentGlobal + deficitLocal; // viser le global + déficit pour que la disponibilité (non achetés) atteigne le besoin
        }
        const res = await ensureExactTypeCounts(targets, { priceMultiplier: inflationIndex });
        createdTotal = Object.values(res).reduce((s, r) => s + r.created, 0);
      }

      // Recompter après éventuelle création
      const after: Record<string, number> = {};
      for (const [uStr] of Object.entries(desired)) {
        after[uStr] = await countAvailable(Number(uStr));
      }

  return reply.send({ ok: true, desired, before, after, created: createdTotal, inflationIndex });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur maintain-bank";
      return reply.status(500).send({ error: message });
    }
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
      // Mise de fonds: accepte 0.2–1.0 (fraction) ou 20–100 (pourcentage)
      downPaymentPercent: z.coerce.number().min(0.2).max(100).optional(),
      mortgageYears: z.number().min(5).max(25).optional(),
    });

    try {
  const params = paramsSchema.parse((req as any).params);
  await assertGameRunning(app, params.gameId);
      const body = bodySchema.parse((req as any).body);
      // Normaliser la mise de fonds: si >1 on considère que c'est un pourcentage (ex: 50) => 0.5
      const normalizedDown = body.downPaymentPercent != null
        ? (body.downPaymentPercent > 1 ? body.downPaymentPercent / 100 : body.downPaymentPercent)
        : undefined;
      const holding = await purchaseProperty({
        gameId: params.gameId,
        playerId: body.playerId,
        templateId: body.templateId,
        mortgageRate: body.mortgageRate,
        downPaymentPercent: normalizedDown,
        mortgageYears: body.mortgageYears,
      });
      // Emit event feed
      (app as any).io?.to(`game:${params.gameId}`).emit("event-feed", {
        type: "property:purchase",
        at: new Date().toISOString(),
        gameId: params.gameId,
        playerId: body.playerId,
        templateId: body.templateId,
        holdingId: holding.id,
      });
      // Déclenchement asynchrone: maintenir la banque après l'achat
      (async () => {
        try {
          // Inflation pour ajuster les prix
          let inflationIndex = 1;
          try {
            const g = await (app.prisma as any).game.findUnique({ where: { id: params.gameId }, select: { inflationIndex: true } });
            inflationIndex = Number(g?.inflationIndex ?? 1) || 1;
          } catch {}
          // Exclure les templates déjà achetés dans cette partie
          const purchased = await app.prisma.propertyHolding.findMany({ where: { gameId: params.gameId }, select: { templateId: true } });
          const purchasedIds = new Set(purchased.map(p => p.templateId));
          const desiredDefault: Record<number, number> = { 1:5, 2:5, 3:5, 6:5, 50:5, 100:5 };
          const deficits: Record<number, number> = {};
          for (const [uStr, need] of Object.entries(desiredDefault)) {
            const u = Number(uStr);
            const avail = await app.prisma.propertyTemplate.count({ where: purchasedIds.size ? { units: u, id: { notIn: Array.from(purchasedIds) } } : { units: u } });
            if (avail < need) deficits[u] = need - avail;
          }
          if (Object.keys(deficits).length) {
            const targets: Record<number, number> = {};
            for (const [uStr, need] of Object.entries(desiredDefault)) {
              const u = Number(uStr);
              const currentGlobal = await app.prisma.propertyTemplate.count({ where: { units: u } });
              const deficitLocal = deficits[u] || 0;
              targets[u] = currentGlobal + deficitLocal;
            }
            await ensureExactTypeCounts(targets, { priceMultiplier: inflationIndex });
          }
        } catch {}
      })();

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

  // POST /api/games/:gameId/properties/backfill-rent-by-units (admin):
  // Corrige currentRent = template.baseRent * template.units pour les holdings existants
  app.post("/api/games/:gameId/properties/backfill-rent-by-units", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    try {
      const holdings = await app.prisma.propertyHolding.findMany({ where: { gameId }, include: { template: true } });
      let updated = 0;
      const errors: { id: string; reason: string }[] = [];
      for (const h of holdings) {
        try {
          const t = h.template;
          if (!t) {
            errors.push({ id: h.id, reason: "template_missing" });
            continue;
          }
          const units = Number((t as any)?.units ?? 1) || 1;
          const baseRent = Number(t.baseRent ?? 0) || 0;
          if (baseRent <= 0) continue; // rien à corriger
          const expected = Math.round(baseRent * Math.max(1, units));
          // Cas à corriger: currentRent absent ou équivalent au baseRent alors que units >1
          const currentRounded = Math.round(Number(h.currentRent ?? 0));
          const isApproxBase = Math.abs(currentRounded - Math.round(baseRent)) <= 1;
          const needsFix = units > 1 && expected !== currentRounded && (currentRounded === 0 || isApproxBase);
          if (needsFix) {
            await app.prisma.propertyHolding.update({ where: { id: h.id }, data: { currentRent: expected } });
            updated++;
          }
        } catch (e: any) {
          errors.push({ id: h.id, reason: e?.message || "update_failed" });
        }
      }
      return reply.send({ ok: true, updated, total: holdings.length, errors });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : "Erreur backfill";
      return reply.status(500).send({ ok: false, error: message });
    }
  });
}
