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

// Garantir un minimum par type (par nombre d'unités)
// Types couverts: 1=Maison, 2=Duplex, 3=Triplex, 6=6-plex, 50=Tour à condos
export async function ensurePropertyTypeQuotas(minPerType = 5) {
  const specs: Array<{ label: string; units: number; rentMin: number; rentMax: number }> = [
    { label: "Maison", units: 1, rentMin: 1200, rentMax: 2200 },
    { label: "Duplex", units: 2, rentMin: 950, rentMax: 1500 },
    { label: "Triplex", units: 3, rentMin: 900, rentMax: 1400 },
    { label: "6-plex", units: 6, rentMin: 800, rentMax: 1200 },
    { label: "Tour à condos (50 log.)", units: 50, rentMin: 1100, rentMax: 1800 },
  ];

  function rand(min: number, max: number) { return Math.random() * (max - min) + min; }
  function randi(min: number, max: number) { return Math.round(rand(min, max)); }
  const cities = [
    "Montréal", "Québec", "Laval", "Gatineau", "Longueuil",
    "Sherbrooke", "Saguenay", "Lévis", "Trois-Rivières", "Terrebonne",
    "Repentigny", "Brossard", "Drummondville", "Granby", "Blainville",
  ];

  const results: Record<string, { before: number; created: number; after: number }> = {};

  for (const spec of specs) {
    const before = await prisma.propertyTemplate.count({ where: { units: spec.units } });
    let deficit = Math.max(0, minPerType - before);
    let created = 0;
    for (let i = 0; i < deficit; i++) {
      const city = cities[(i + created) % cities.length];
      const baseRent = randi(spec.rentMin, spec.rentMax);
      const annualGross = baseRent * spec.units * 12;
      const grm = Math.round(rand(10, 15) * 10) / 10; // 10.0..15.0
      const price = Math.round(annualGross * grm);
      const expensesAnnual = Math.round(annualGross * rand(0.25, 0.35));
      const taxes = Math.round(expensesAnnual * 0.4);
      const insurance = Math.round(expensesAnnual * 0.15);
      const maintenance = Math.round(expensesAnnual * 0.45);
      const plumbingState = ["bon", "moyen", "à rénover"][i % 3];
      const electricityState = ["bon", "moyen", "à rénover"][ (i+1) % 3];
      const roofState = ["bon", "moyen", "à rénover"][ (i+2) % 3];
      const name = `${spec.label} (auto) #${Date.now()}-${i}`;
      const imageUrl = illustrationForType(spec.label);

      await prisma.propertyTemplate.create({
        data: {
          name,
          city,
          imageUrl,
          description: `${spec.label} à ${city} · ${spec.units} logement(s). Loyer unitaire ≈ ${baseRent}$/mois.`,
          price,
          baseRent,
          taxes,
          insurance,
          maintenance,
          units: spec.units,
          plumbingState,
          electricityState,
          roofState,
        } as any,
      });
      created++;
    }
    const after = await prisma.propertyTemplate.count({ where: { units: spec.units } });
    results[`${spec.label}(${spec.units})`] = { before, created, after };
  }

  return results;
}

// Assurer des cibles exactes par type (par nombre d'unités)
// Exemple: {1:10,2:10,3:10,6:10,50:5} => au moins ces quantités en banque.
export async function ensureExactTypeCounts(targets: Record<number, number>) {
  function rand(min: number, max: number) { return Math.random() * (max - min) + min; }
  function randi(min: number, max: number) { return Math.round(rand(min, max)); }
  const cities = [
    "Montréal", "Québec", "Laval", "Gatineau", "Longueuil",
    "Sherbrooke", "Saguenay", "Lévis", "Trois-Rivières", "Terrebonne",
    "Repentigny", "Brossard", "Drummondville", "Granby", "Blainville",
  ];
  const labelOf = (u: number) => u >= 50 ? "Tour à condos (50 log.)" : (u === 6 ? "6-plex" : (u === 3 ? "Triplex" : (u === 2 ? "Duplex" : "Maison")));
  const rentRange: Record<number, { min: number; max: number }> = {
    1: { min: 1200, max: 2200 },
    2: { min: 950, max: 1500 },
    3: { min: 900, max: 1400 },
    6: { min: 800, max: 1200 },
    50: { min: 1100, max: 1800 },
  };

  const results: Record<string, { before: number; created: number; after: number }> = {};

  for (const [uStr, target] of Object.entries(targets)) {
    const units = Number(uStr);
    const label = labelOf(units);
    const before = await prisma.propertyTemplate.count({ where: { units } });
    let deficit = Math.max(0, Number(target) - before);
    let created = 0;
    const rr = rentRange[units] || { min: 900, max: 1600 };
    for (let i = 0; i < deficit; i++) {
      const city = cities[(i + created) % cities.length];
      const baseRent = randi(rr.min, rr.max);
      const annualGross = baseRent * units * 12;
      const grm = Math.round(rand(10, 15) * 10) / 10; // 10.0..15.0
      const price = Math.round(annualGross * grm);
      const expensesAnnual = Math.round(annualGross * rand(0.25, 0.35));
      const taxes = Math.round(expensesAnnual * 0.4);
      const insurance = Math.round(expensesAnnual * 0.15);
      const maintenance = Math.round(expensesAnnual * 0.45);
      const plumbingState = ["bon", "moyen", "à rénover"][i % 3];
      const electricityState = ["bon", "moyen", "à rénover"][ (i+1) % 3];
      const roofState = ["bon", "moyen", "à rénover"][ (i+2) % 3];
      const name = `${label} (auto) #${Date.now()}-${i}`;
      const imageUrl = illustrationForType(label);
      await prisma.propertyTemplate.create({
        data: {
          name,
          city,
          imageUrl,
          description: `${label} à ${city} · ${units} logement(s). Loyer unitaire ≈ ${baseRent}$/mois.`,
          price,
          baseRent,
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
    const after = await prisma.propertyTemplate.count({ where: { units } });
    results[`${label}(${units})`] = { before, created, after };
  }

  return results;
}
