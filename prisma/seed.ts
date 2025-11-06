import 'dotenv/config';
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

const QC_CITIES = [
  "Montréal", "Québec", "Laval", "Gatineau", "Longueuil",
  "Sherbrooke", "Saguenay", "Lévis", "Trois-Rivières", "Terrebonne",
  "Repentigny", "Brossard", "Drummondville", "Granby", "Blainville",
];

function pick<T>(arr: T[], i: number): T { return arr[i % arr.length]; }
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

type JsonImmeuble = {
  id: string;
  type: "Maison" | "Duplex" | "Triplex" | string;
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
  if (type === "Duplex") return 2;
  if (type === "Triplex") return 3;
  return 1;
}

function toStateLabel(score: number): "bon" | "moyen" | "à rénover" {
  if (score >= 80) return "bon";
  if (score >= 60) return "moyen";
  return "à rénover";
}

function illustrationForType(t: string): string {
  const key = t.toLowerCase();
  if (key.includes("duplex")) return "/images/props/duplex.svg";
  if (key.includes("triplex")) return "/images/props/triplex.svg";
  if (/(quadruplex|4-?plex|fourplex)/i.test(t)) return "/images/props/quadruplex.svg";
  if (/(6-?plex|sixplex|six-?plex)/i.test(t)) return "/images/props/6plex.svg";
  if (/(condo|tour|tower|gratte-ciel)/i.test(t)) return "/images/props/condo-tower.svg";
  if (/(commercial|commerciale)/i.test(t)) return "/images/props/commercial.svg";
  // défaut: maison
  return "/images/props/maison.svg";
}

async function seedFromJson(): Promise<number> {
  const file = path.resolve(__dirname, "data", "immeubles_seed.json");
  if (!fs.existsSync(file)) {
    console.log("Aucun fichier JSON d'immeubles trouvé, on passe.");
    return 0;
  }
  const raw = fs.readFileSync(file, "utf-8");
  const data: JsonImmeuble[] = JSON.parse(raw);
  let created = 0;
  for (const im of data) {
    const units = toUnits(im.type);
    const monthlyPerUnit = Math.max(0, Math.round(im.revenuAnnuel / 12 / units));
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
        // Utiliser des illustrations locales par type (maison/duplex/triplex)
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
  console.log(`Seed JSON: +${created} PropertyTemplate ajoutés depuis le fichier.`);
  return created;
}

async function seedGenerated(minTotal = 50): Promise<number> {
  const existing = await prisma.propertyTemplate.count();
  const toCreate = Math.max(0, minTotal - existing);
  if (toCreate <= 0) {
    console.log(`Seed généré: base non nécessaire (déjà ${existing} templates).`);
    return 0;
  }

  const startIndex = existing; // continuer le compteur de noms
  const templates = Array.from({ length: toCreate }).map((_, idx) => {
    const i = startIndex + idx;
    const city = pick(QC_CITIES, i);
    const price = 180_000 + (i % 50) * 35_000;
    const units = 1 + (i % 6);
    const baseRent = clamp(750 + (i % 10) * 85, 700, 2200);
    const taxes = clamp(2_000 + (i % 50) * 180, 1_500, 9_000);
    const insurance = clamp(700 + (i % 50) * 45, 500, 3_000);
    const maintenance = clamp(900 + (i % 50) * 95, 600, 7_000);
    const cycle = ["bon", "moyen", "à rénover"] as const;
    const plumbingState = pick(cycle as unknown as string[], i + 1);
    const electricityState = pick(cycle as unknown as string[], i + 2);
    const roofState = pick(cycle as unknown as string[], i + 3);

    const name = `Immeuble #${String(i + 1).padStart(2, "0")}`;
    // Déduire un "type" simple à partir du nombre d'unités pour illustrer
    const kind = units === 1 ? "Maison" : units === 2 ? "Duplex" : units === 3 ? "Triplex" : units === 4 ? "Quadruplex" : units >= 6 ? "6-plex" : "Maison";
    const imageUrl = illustrationForType(kind);
    return {
      name,
      city,
      imageUrl,
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

  if (templates.length > 0) {
    await prisma.propertyTemplate.createMany({ data: templates });
  }
  console.log(`Seed généré: +${templates.length} PropertyTemplate synthétiques ajoutés (objectif ${minTotal}).`);
  return templates.length;
}

// Génère une banque structurée demandée: 10 maisons, 10 duplex, 10 triplex, 10 6-plex, 5 tours (50 log.)
async function seedBankFixedCounts(): Promise<number> {
  type Spec = { label: string; units: number; count: number; rentMin: number; rentMax: number };
  const specs: Spec[] = [
    { label: "Maison", units: 1, count: 10, rentMin: 1200, rentMax: 2200 },
    { label: "Duplex", units: 2, count: 10, rentMin: 950, rentMax: 1500 },
    { label: "Triplex", units: 3, count: 10, rentMin: 900, rentMax: 1400 },
    { label: "6-plex", units: 6, count: 10, rentMin: 800, rentMax: 1200 },
    { label: "Tour à condos (50 log.)", units: 50, count: 5, rentMin: 1100, rentMax: 1800 },
  ];

  const cityCycle = QC_CITIES;
  let created = 0;

  function rand(min: number, max: number) { return Math.random() * (max - min) + min; }
  function randi(min: number, max: number) { return Math.round(rand(min, max)); }

  for (const spec of specs) {
    for (let i = 0; i < spec.count; i++) {
      const city = cityCycle[(i + created) % cityCycle.length];
      const baseRent = randi(spec.rentMin, spec.rentMax);
      const annualGross = baseRent * spec.units * 12;
      const grm = Math.round(rand(10, 15) * 10) / 10; // 10.0 à 15.0
      const price = Math.round(annualGross * grm);
      const expensesAnnual = Math.round(annualGross * rand(0.25, 0.35));
      const taxes = Math.round(expensesAnnual * 0.4);
      const insurance = Math.round(expensesAnnual * 0.15);
      const maintenance = Math.round(expensesAnnual * 0.45);
      const plumbingState = ["bon", "moyen", "à rénover"][i % 3];
      const electricityState = ["bon", "moyen", "à rénover"][ (i+1) % 3];
      const roofState = ["bon", "moyen", "à rénover"][ (i+2) % 3];
      const name = `${spec.label} #${String(i + 1).padStart(2, "0")} — GRM ${grm.toFixed(1)}×`;

      const exists = await prisma.propertyTemplate.findFirst({ where: { name }, select: { id: true } });
      if (exists) continue;

      await prisma.propertyTemplate.create({
        data: {
          name,
          city,
          imageUrl: illustrationForType(spec.label),
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
  }
  if (created) console.log(`Seed banque structurée: +${created} gabarits ajoutés (maisons/duplex/triplex/6-plex/tours).`);
  return created;
}

async function main() {
  // 1) Toujours tenter l'import JSON (idempotent)
  await seedFromJson();

  // 2) Créer la banque structurée demandée (idempotent)
  await seedBankFixedCounts();

  // 3) Assurer un minimum de 50 templates au total avec génération si besoin
  await seedGenerated(50);

  const total = await prisma.propertyTemplate.count();
  console.log(`Seed TS terminé: total PropertyTemplate = ${total}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
