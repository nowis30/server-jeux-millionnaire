"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listListings = listListings;
exports.createListing = createListing;
exports.cancelListing = cancelListing;
exports.acceptListing = acceptListing;
const prisma_1 = require("../prisma");
async function listListings(gameId) {
    return prisma_1.prisma.listing.findMany({ where: { gameId }, orderBy: { createdAt: "desc" } });
}
async function createListing(params) {
    const { gameId, sellerId, holdingId, templateId, price } = params;
    if (!holdingId && !templateId)
        throw new Error("holdingId ou templateId requis");
    return prisma_1.prisma.listing.create({
        data: { gameId, holdingId, templateId, sellerId, price, type: params.type ?? "fixed" },
    });
}
async function cancelListing(listingId, sellerId) {
    const listing = await prisma_1.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing)
        throw new Error("Listing introuvable");
    if (listing.sellerId && listing.sellerId !== sellerId)
        throw new Error("Non autorisé");
    await prisma_1.prisma.listing.delete({ where: { id: listingId } });
}
async function acceptListing(listingId, buyerId) {
    const listing = await prisma_1.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing)
        throw new Error("Listing introuvable");
    if (!listing.price)
        throw new Error("Prix invalide");
    // vérifier acheteur et fonds
    const buyer = await prisma_1.prisma.player.findUnique({ where: { id: buyerId } });
    if (!buyer)
        throw new Error("Acheteur introuvable");
    if (buyer.cash < listing.price)
        throw new Error("Fonds insuffisants");
    // si vente d'un bien existant (holdingId)
    if (listing.holdingId) {
        const holding = await prisma_1.prisma.propertyHolding.findUnique({ where: { id: listing.holdingId } });
        if (!holding)
            throw new Error("Bien introuvable");
        if (holding.gameId !== listing.gameId)
            throw new Error("Conflit de partie");
        // effectuer transfert: cash du buyer vers seller, propriété vers buyer
        return prisma_1.prisma.$transaction(async (tx) => {
            // joueurs
            const seller = listing.sellerId
                ? await tx.player.findUnique({ where: { id: listing.sellerId } })
                : null;
            if (listing.sellerId && !seller)
                throw new Error("Vendeur introuvable");
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
