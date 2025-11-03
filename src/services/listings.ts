import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

export async function listListings(gameId: string) {
  return prisma.listing.findMany({ where: { gameId }, orderBy: { createdAt: "desc" } });
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

  // MVP: pour templateId, on ne crée pas l'actif ici (trop proche d'un achat classique)
  throw new Error("Listing de template non supporté dans le MVP");
}
