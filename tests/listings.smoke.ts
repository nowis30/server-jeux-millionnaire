import { prisma } from "../src/prisma";
import { createListing, acceptListing } from "../src/services/listings";

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const code = `T${suffix}`;
  const price = 50000;

  // Créer game
  const game = await prisma.game.create({ data: { code, status: "running" } });

  // Créer joueurs
  const seller = await prisma.player.create({ data: { nickname: `seller_${suffix}`, cash: 200000, netWorth: 200000, gameId: game.id, guestId: `guest_s_${suffix}` } });
  const buyer = await prisma.player.create({ data: { nickname: `buyer_${suffix}`, cash: 300000, netWorth: 300000, gameId: game.id, guestId: `guest_b_${suffix}` } });

  // Template + holding
  const template = await prisma.propertyTemplate.create({
    data: {
      name: `Test Immeuble ${suffix}`,
      city: "Testville",
      imageUrl: "https://example.com/img.jpg",
      price: 150000,
      baseRent: 1200,
      taxes: 200,
      insurance: 100,
      maintenance: 80,
    },
  });

  const holding = await prisma.propertyHolding.create({
    data: {
      playerId: seller.id,
      gameId: game.id,
      templateId: template.id,
      purchasePrice: template.price,
      currentValue: template.price,
      currentRent: template.baseRent,
      mortgageRate: 0.05,
      mortgageDebt: 20000,
      weeklyPayment: 100,
    },
  });

  // Créer une annonce
  const listing = await createListing({ gameId: game.id, sellerId: seller.id, holdingId: holding.id, price });

  // Accepter l'annonce
  await acceptListing(listing.id, buyer.id);

  // Vérifications
  const listingGone = await prisma.listing.findUnique({ where: { id: listing.id } });
  if (listingGone) throw new Error("Listing non supprimé");

  const holdingAfter = await prisma.propertyHolding.findUnique({ where: { id: holding.id } });
  if (!holdingAfter) throw new Error("Holding disparu");
  if (holdingAfter.playerId !== buyer.id) throw new Error("Holding non transféré à l'acheteur");

  const sellerAfter = await prisma.player.findUnique({ where: { id: seller.id } });
  const buyerAfter = await prisma.player.findUnique({ where: { id: buyer.id } });
  if (!sellerAfter || !buyerAfter) throw new Error("Joueurs introuvables après transfert");

  if (sellerAfter.cash < 200000 + price - 1) throw new Error("Cash vendeur non crédité");
  if (buyerAfter.cash > 300000 - price + 1) throw new Error("Cash acheteur non débité");

  console.log("SMOKE LISTINGS: PASS", { gameId: game.id, listingId: listing.id, holdingId: holding.id });
}

main().then(() => process.exit(0)).catch(async (err) => {
  console.error("SMOKE LISTINGS: FAIL", err);
  process.exit(1);
});
