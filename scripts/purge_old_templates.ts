import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.propertyTemplate.findMany({
    where: {
      OR: [
        { name: { startsWith: "Immeuble #" } },
        { imageUrl: { startsWith: "https://picsum.photos" } },
      ],
    },
    select: { id: true, name: true, imageUrl: true },
  });

  if (!candidates.length) {
    console.log("[purge] Aucun ancien template à supprimer.");
    return;
  }

  // Vérifier les holdings associés et ne supprimer que ceux sans holdings
  const ids = candidates.map((c: { id: string }) => c.id);
  const counts = await prisma.propertyHolding.groupBy({ by: ["templateId"], where: { templateId: { in: ids } }, _count: { _all: true } });
  const withHoldings = new Set(counts.filter((c: any) => c._count._all > 0).map((c: any) => c.templateId as string));
  const deletable = candidates.filter((c: { id: string }) => !withHoldings.has(c.id)).map((c: { id: string }) => c.id);

  if (!deletable.length) {
    console.log(`[purge] ${candidates.length} anciens détectés, mais tous ont des holdings. Rien supprimé.`);
    return;
  }

  // Supprimer d'abord les listings liés, puis les templates
  const delListings = await prisma.listing.deleteMany({ where: { templateId: { in: deletable } } });
  const delTemplates = await prisma.propertyTemplate.deleteMany({ where: { id: { in: deletable } } });
  const skipped = candidates.length - deletable.length;
  console.log(`[purge] Templates supprimés: ${delTemplates.count} · Listings supprimés: ${delListings.count} · Skippés (avaient des holdings): ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
