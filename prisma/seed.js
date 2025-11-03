const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const QC_CITIES = [
    "Montréal", "Québec", "Laval", "Gatineau", "Longueuil",
    "Sherbrooke", "Saguenay", "Lévis", "Trois-Rivières", "Terrebonne",
    "Repentigny", "Brossard", "Drummondville", "Granby", "Blainville",
];

function pick(arr, i) { return arr[i % arr.length]; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

async function main() {
    // Nettoyage léger (optionnel): on conserve les holdings existants, mais on (re)peuple les templates si vide
    const existing = await prisma.propertyTemplate.count();
    if (existing >= 50) {
        // Recalculer (ou remplir) les descriptions en SQL brut (évite prisma generate)
        const rows = await prisma.propertyTemplate.findMany({
            select: { id: true, city: true, baseRent: true, units: true, plumbingState: true, electricityState: true, roofState: true },
        });
        let updated = 0;
        for (const t of rows) {
            const desc = `Bel immeuble locatif situé à ${t.city}. ${t.units} logement(s), état plomberie: ${t.plumbingState}, électricité: ${t.electricityState}, toiture: ${t.roofState}. Revenus potentiels stables avec loyer de base ≈ ${Math.round(t.baseRent)}$ par unité.`;
            await prisma.$executeRaw`UPDATE "PropertyTemplate" SET "description" = ${desc} WHERE "id" = ${t.id}`;
            updated++;
        }
        console.log(`Seed: ${existing} templates — descriptions (ré)écrites pour ${updated}.`);
        return;
    }

    const templates = Array.from({ length: 50 }).map((_, i) => {
        const city = pick(QC_CITIES, i);
        // Prix entre 180k et 1.2M selon l’index
        const price = 180_000 + i * 35_000;
        const units = 1 + (i % 6); // 1 à 6 logements
        const baseRent = clamp(750 + (i % 10) * 85, 700, 2200); // loyer unitaire mensuel
        // Charges annuelles approximatives
        const taxes = clamp(2_000 + i * 180, 1_500, 9_000);
        const insurance = clamp(700 + i * 45, 500, 3_000);
        const maintenance = clamp(900 + i * 95, 600, 7_000);
        const stateCycle = ["bon", "moyen", "à rénover"];
        const plumbingState = pick(stateCycle, i + 1);
        const electricityState = pick(stateCycle, i + 2);
        const roofState = pick(stateCycle, i + 3);

        return {
            name: `Immeuble #${String(i + 1).padStart(2, "0")}`,
            city,
            imageUrl: `https://picsum.photos/seed/hmqc${i}/640/360`,
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

    if (existing === 0) {
        await prisma.propertyTemplate.createMany({ data: templates });
        console.log("Seed terminé: 50 PropertyTemplate QC créés.");
    } else {
        // Compléter jusqu'à 50 et mettre à jour descriptions vides
        const toCreate = templates.slice(existing);
        if (toCreate.length > 0) {
            await prisma.propertyTemplate.createMany({ data: toCreate });
            console.log(`Seed: ajout de ${toCreate.length} templates pour atteindre 50.`);
        }
        const rows = await prisma.propertyTemplate.findMany({
            select: { id: true, city: true, baseRent: true, units: true, plumbingState: true, electricityState: true, roofState: true },
        });
        let updated = 0;
        for (const t of rows) {
            const desc = `Bel immeuble locatif situé à ${t.city}. ${t.units} logement(s), état plomberie: ${t.plumbingState}, électricité: ${t.electricityState}, toiture: ${t.roofState}. Revenus potentiels stables avec loyer de base ≈ ${Math.round(t.baseRent)}$ par unité.`;
            await prisma.$executeRaw`UPDATE "PropertyTemplate" SET "description" = ${desc} WHERE "id" = ${t.id}`;
            updated++;
        }
        console.log(`Seed: descriptions (ré)écrites pour ${updated} templates.`);
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
