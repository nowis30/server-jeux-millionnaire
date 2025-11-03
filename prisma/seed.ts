import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Nettoyage (développement): réinitialiser les données liées à l'immobilier
  await prisma.listing.deleteMany({});
  await prisma.propertyHolding.deleteMany({});
  await prisma.propertyTemplate.deleteMany({});

  // 30 immeubles fictifs
  const templates = Array.from({ length: 30 }).map((_, i) => {
    const n = (i + 1).toString().padStart(2, "0");
    return {
      name: `Immeuble #${i + 1}`,
      city: ["Montréal", "Toronto", "Vancouver", "Québec"][i % 4],
      // Utilise des images locales à placer dans client/public/images/immeubles
      // Exemple de fichier: client/public/images/immeubles/immeuble-01.jpg
      imageUrl: `/images/immeubles/immeuble-${n}.jpg`,
      price: 150_000 + i * 50_000,
      baseRent: 1_200 + i * 150,
      taxes: 2_500 + i * 200,
      insurance: 900 + i * 50,
      maintenance: 1_000 + i * 100,
    };
  });

  await prisma.propertyTemplate.createMany({ data: templates });
  console.log("Seed terminé: 30 PropertyTemplate créés.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
