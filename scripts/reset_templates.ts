import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";

const prisma = new PrismaClient();

async function main() {
  console.log("[reset] Début reset des PropertyTemplate (suppression des non-utilisés + reseed à 50).");

  // Trouver les templates sans holdings
  const all = await prisma.propertyTemplate.findMany({ select: { id: true, name: true } });
  const ids = all.map((t: { id: string; name: string }) => t.id);
  const counts = await prisma.propertyHolding.groupBy({ by: ["templateId"], where: { templateId: { in: ids } }, _count: { _all: true } });
  const withHoldings = new Set(counts.filter((c: any) => c._count._all > 0).map((c: any) => c.templateId as string));
  const deletable = all.filter((t: { id: string }) => !withHoldings.has(t.id)).map((t: { id: string }) => t.id);

  // Supprimer listings liés puis templates
  if (deletable.length) {
    const delListings = await prisma.listing.deleteMany({ where: { templateId: { in: deletable } } });
    const delTemplates = await prisma.propertyTemplate.deleteMany({ where: { id: { in: deletable } } });
    console.log(`[reset] Supprimés: ${delTemplates.count} templates · Listings supprimés: ${delListings.count}`);
  } else {
    console.log("[reset] Aucun template supprimable (tous ont des holdings). On passe.");
  }

  await prisma.$disconnect();

  // Relancer le seed pour remonter à 50 min
  try {
    console.log("[reset] Exécution du seed…");
    execSync("npm run seed", { stdio: "inherit" });
    console.log("[reset] Seed terminé.");
  } catch (e) {
    console.error("[reset] Seed a échoué", e);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
