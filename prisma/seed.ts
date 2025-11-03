import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const QC_CITIES = [
  "Montréal", "Québec", "Laval", "Gatineau", "Longueuil",
  "Sherbrooke", "Saguenay", "Lévis", "Trois-Rivières", "Terrebonne",
  "Repentigny", "Brossard", "Drummondville", "Granby", "Blainville",
];

function pick<T>(arr: T[], i: number): T { return arr[i % arr.length]; }
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

async function main() {
  // Ne repeuple que si vide (sécurité en dev)
  const existing = await prisma.propertyTemplate.count();
  if (existing > 0) {
    console.log(`Seed TS: ${existing} templates existent déjà — aucun ajout.`);
    return;
  }

  const templates = Array.from({ length: 50 }).map((_, i) => {
    const city = pick(QC_CITIES, i);
    const price = 180_000 + i * 35_000;
    const units = 1 + (i % 6);
    const baseRent = clamp(750 + (i % 10) * 85, 700, 2200);
    const taxes = clamp(2_000 + i * 180, 1_500, 9_000);
    const insurance = clamp(700 + i * 45, 500, 3_000);
    const maintenance = clamp(900 + i * 95, 600, 7_000);
    const cycle = ["bon", "moyen", "à rénover"] as const;
    const plumbingState = pick(cycle as unknown as string[], i + 1);
    const electricityState = pick(cycle as unknown as string[], i + 2);
    const roofState = pick(cycle as unknown as string[], i + 3);

    return {
      name: `Immeuble #${String(i + 1).padStart(2, "0")}`,
      city,
      imageUrl: `https://picsum.photos/seed/hmqc${i}/640/360`,
      description: `Bel immeuble locatif situé à ${city}. ${units} logement(s), état plomberie: ${plumbingState}, électricité: ${electricityState}, toiture: ${roofState}. Revenus potentiels stables avec loyer de base ≈ ${Math.round(baseRent)}$ par unité.`,
      price,
      baseRent,
      taxes,
      insurance,
      maintenance,
      units,
      plumbingState,
      electricityState,
      roofState,
    };
  });

  await prisma.propertyTemplate.createMany({ data: templates });
  console.log("Seed TS terminé: 50 PropertyTemplate QC créés.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
