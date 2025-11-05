import fs from "fs";
import path from "path";
import { prisma } from "../prisma";

type JsonImmeuble = {
  id: string;
  type: string;
  ville: string;
  photoUrl: string;
  valeurMarchande: number;
  revenuAnnuel: number;
  depensesAnnuel: number;
  etat: { toiture: number; plomberie: number; electricite: number; fenetres: number; revetement: number };
  renovationsPrevues: string;
  capRate: number;
  vacance: number;
  anneeConstruction: number;
  latitude: number;
  longitude: number;
};

function toUnits(type: string): number {
  const t = (type || "").toLowerCase();
  if (t.includes("6-plex") || t.includes("sixplex") || t.includes("6plex")) return 6;
  if (t.includes("quadruplex") || t.includes("4-plex") || t.includes("fourplex")) return 4;
  if (t.includes("triplex")) return 3;
  if (t.includes("duplex")) return 2;
  return 1;
}

function toStateLabel(score: number): "bon" | "moyen" | "à rénover" {
  if (score >= 80) return "bon";
  if (score >= 60) return "moyen";
  return "à rénover";
}

function illustrationForType(t: string): string {
  const key = (t || "").toLowerCase();
  if (key.includes("duplex")) return "/images/props/duplex.svg";
  if (key.includes("triplex")) return "/images/props/triplex.svg";
  if (/(quadruplex|4-?plex|fourplex)/i.test(t)) return "/images/props/quadruplex.svg";
  if (/(6-?plex|sixplex|six-?plex)/i.test(t)) return "/images/props/6plex.svg";
  if (/(commercial|commerciale)/i.test(t)) return "/images/props/commercial.svg";
  return "/images/props/maison.svg";
}

export async function seedTemplatesFromJson(): Promise<number> {
  // En prod, __dirname pointe vers dist/services → remonter vers prisma/data
  const file = path.resolve(__dirname, "../../prisma/data/immeubles_seed.json");
  if (!fs.existsSync(file)) return 0;
  const raw = fs.readFileSync(file, "utf-8");
  const data: JsonImmeuble[] = JSON.parse(raw);
  let created = 0;
  for (const im of data) {
    const units = toUnits(im.type);
    const monthlyPerUnit = Math.max(0, Math.round(im.revenuAnnuel / 12 / Math.max(1, units)));
    const taxes = Math.round(im.depensesAnnuel * 0.4);
    const insurance = Math.round(im.depensesAnnuel * 0.15);
    const maintenance = Math.round(im.depensesAnnuel * 0.45);
    const roofState = toStateLabel(im.etat.toiture);
    const plumbingState = toStateLabel(im.etat.plomberie);
    const electricityState = toStateLabel(im.etat.electricite);
    const name = `${im.id} · ${im.type} ${im.ville}`;
    const exists = await prisma.propertyTemplate.findFirst({ where: { name }, select: { id: true } });
    if (exists) continue;
    await prisma.propertyTemplate.create({
      data: {
        name,
        city: im.ville,
        imageUrl: im.photoUrl && im.photoUrl.startsWith("/") ? im.photoUrl : illustrationForType(im.type),
        description: [
          `Type: ${im.type}, Année: ${im.anneeConstruction}`,
          `Cap rate: ${im.capRate.toFixed(2)}%, Vacance: ${(im.vacance * 100).toFixed(0)}%`,
          `Rénovations: ${im.renovationsPrevues}`,
          `États — Toiture: ${roofState}, Plomberie: ${plumbingState}, Électricité: ${electricityState}`,
        ].join(" | "),
        price: im.valeurMarchande,
        baseRent: monthlyPerUnit,
        taxes,
        insurance,
        maintenance,
        units,
        plumbingState,
        electricityState,
        roofState,
      } as any,
    });
    created++;
  }
  return created;
}

export async function seedTemplatesGenerate(minTotal = 50): Promise<number> {
  const existing = await prisma.propertyTemplate.count();
  const toCreate = Math.max(0, minTotal - existing);
  if (toCreate <= 0) return 0;
  const QC_CITIES = [
    "Montréal", "Québec", "Laval", "Gatineau", "Longueuil",
    "Sherbrooke", "Saguenay", "Lévis", "Trois-Rivières", "Terrebonne",
    "Repentigny", "Brossard", "Drummondville", "Granby", "Blainville",
  ];
  function pick<T>(arr: T[], i: number): T { return arr[i % arr.length]; }
  function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

  const startIndex = existing;
  const templates = Array.from({ length: toCreate }).map((_, idx) => {
    const i = startIndex + idx;
    const city = pick(QC_CITIES, i);
    const price = 180_000 + (i % 50) * 35_000;
    const units = 1 + (i % 6);
    
    // Loyers augmentés de ~30% pour meilleure rentabilité
    const baseRent = clamp(1000 + (i % 10) * 120, 950, 2800);
    
    // Dépenses réduites de ~25% pour meilleur cash flow
    const taxes = clamp(1_500 + (i % 50) * 140, 1_200, 7_000);
    const insurance = clamp(550 + (i % 50) * 35, 400, 2_500);
    const maintenance = clamp(700 + (i % 50) * 75, 500, 5_500);
    
    const cycle = ["bon", "moyen", "à rénover"] as const;
    const plumbingState = pick(cycle as unknown as string[], i + 1);
    const electricityState = pick(cycle as unknown as string[], i + 2);
    const roofState = pick(cycle as unknown as string[], i + 3);
    const name = `Immeuble #${String(i + 1).padStart(2, "0")}`;
    const kind = units === 1 ? "Maison" : units === 2 ? "Duplex" : units === 3 ? "Triplex" : units === 4 ? "Quadruplex" : units >= 6 ? "6-plex" : "Maison";
    const imageUrl = illustrationForType(kind);
    return {
      name,
      city,
      imageUrl,
      description: `Bel immeuble locatif situé à ${city}. ${units} logement(s).`,
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
  if (templates.length > 0) {
    await prisma.propertyTemplate.createMany({ data: templates });
  }
  return templates.length;
}

export async function seedAll(minTotal = 50) {
  const fromJson = await seedTemplatesFromJson();
  const gen = await seedTemplatesGenerate(minTotal);
  const total = await prisma.propertyTemplate.count();
  return { fromJson, gen, total };
}
