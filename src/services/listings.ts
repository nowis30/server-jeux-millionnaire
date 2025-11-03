import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { purchaseProperty } from "./property";

export async function listListings(gameId: string) {
  // Inclure détails pour l'affichage (photo/desc via template)
  return prisma.listing.findMany({
    where: { gameId },
    orderBy: { createdAt: "desc" },
    include: {
      template: true,
      holding: { include: { template: true } },
    },
  });
}

export async function createListing(params: {
  gameId: string;
  sellerId: string;
  holdingId?: string; // vendre un bien existant
  templateId?: string; // proposer un template (pré-achat)
  price: number;
  type?: string; // fixed | auction (MVP: fixed)
}) {
  const { gameId, sellerId, holdingId, templateId, price } = params;
  if (!holdingId && !templateId) throw new Error("holdingId ou templateId requis");
  return prisma.listing.create({
    data: { gameId, holdingId, templateId, sellerId, price, type: params.type ?? "fixed" },
  });
}

export async function cancelListing(listingId: string, sellerId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) throw new Error("Listing introuvable");
  if (listing.sellerId && listing.sellerId !== sellerId) throw new Error("Non autorisé");
  await prisma.listing.delete({ where: { id: listingId } });
}

export async function acceptListing(listingId: string, buyerId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) throw new Error("Listing introuvable");
  if (!listing.price) throw new Error("Prix invalide");

  // vérifier acheteur et fonds
  const buyer = await prisma.player.findUnique({ where: { id: buyerId } });
  if (!buyer) throw new Error("Acheteur introuvable");
  if (buyer.cash < listing.price) throw new Error("Fonds insuffisants");

  // si vente d'un bien existant (holdingId)
  if (listing.holdingId) {
    const holding = await prisma.propertyHolding.findUnique({ where: { id: listing.holdingId } });
    if (!holding) throw new Error("Bien introuvable");
    if (holding.gameId !== listing.gameId) throw new Error("Conflit de partie");

    // effectuer transfert: cash du buyer vers seller, propriété vers buyer
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // joueurs
      const seller = listing.sellerId
        ? await tx.player.findUnique({ where: { id: listing.sellerId } })
        : null;
      if (listing.sellerId && !seller) throw new Error("Vendeur introuvable");

      await tx.player.update({ where: { id: buyerId }, data: { cash: buyer.cash - listing.price } });
      if (seller) {
        await tx.player.update({ where: { id: seller.id }, data: { cash: seller.cash + listing.price } });
      }

      // transfert propriété
      await tx.propertyHolding.update({ where: { id: holding.id }, data: { playerId: buyerId } });

      // supprimer le listing
      await tx.listing.delete({ where: { id: listingId } });

      return { status: "ok", holdingId: holding.id, price: listing.price };
    });
  }

  // Support des annonces issues de la banque (templateId)
  if (listing.templateId) {
    const template = await prisma.propertyTemplate.findUnique({ where: { id: listing.templateId } });
    if (!template) throw new Error("Template introuvable");

    // Effectuer un achat standard (avec apport par défaut)
    const holding = await purchaseProperty({
      gameId: listing.gameId,
      playerId: buyerId,
      templateId: listing.templateId,
    });

    // Débiter le prix n'est pas nécessaire ici: purchaseProperty gère l'apport et la dette
    await prisma.listing.delete({ where: { id: listingId } });
    return { status: "ok", holdingId: holding.id, price: listing.price };
  }

  throw new Error("Type d'annonce non reconnu");
}

// Assurer un lot d'annonces de templates en rotation pour une partie
export async function ensureTemplateListings(gameId: string, desiredCount = 12, rotateCount = 2) {
  // Templates déjà achetés dans la partie
  const owned = await prisma.propertyHolding.findMany({ where: { gameId }, select: { templateId: true } });
  const ownedSet = new Set(owned.map((o: { templateId: string }) => o.templateId));

  // Annonces de templates existantes
  const current = await prisma.listing.findMany({
    where: { gameId, templateId: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  // Retirer quelques plus anciennes pour faire tourner
  const toRemove = current.slice(0, Math.max(0, Math.min(rotateCount, current.length)));
  if (toRemove.length) {
    await prisma.listing.deleteMany({ where: { id: { in: toRemove.map((l: { id: string }) => l.id) } } });
  }

  // Recompter après suppression
  const remaining = current.length - toRemove.length;
  const toAdd = Math.max(0, desiredCount - remaining);
  if (toAdd === 0) return;

  // Candidats: templates non possédés et non déjà listés
  const listedTemplateIds = new Set(
    current
      .slice(toRemove.length)
      .map((l: { templateId: string | null }) => l.templateId as string | null)
      .filter(Boolean) as string[]
  );
  const candidates = await prisma.propertyTemplate.findMany({ orderBy: { price: "asc" } });
  const pool = candidates.filter((t: { id: string }) => !ownedSet.has(t.id) && !listedTemplateIds.has(t.id));

  // Choisir pseudo-aléatoirement
  for (let i = 0; i < toAdd && i < pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const t = pool.splice(idx, 1)[0];
    await prisma.listing.create({
      data: {
        gameId,
        templateId: t.id,
        price: t.price,
        type: "fixed",
      },
    });
  }
}
