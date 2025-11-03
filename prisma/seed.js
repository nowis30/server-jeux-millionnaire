import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
    // 10 immeubles fictifs
    const templates = Array.from({ length: 10 }).map((_, i) => ({
        name: `Immeuble #${i + 1}`,
        city: ["Montréal", "Toronto", "Vancouver", "Québec"][i % 4],
        imageUrl: `https://picsum.photos/seed/hm${i}/640/360`,
        price: 150000 + i * 50000,
        baseRent: 1200 + i * 150,
        taxes: 2500 + i * 200,
        insurance: 900 + i * 50,
        maintenance: 1000 + i * 100,
    }));
    await prisma.propertyTemplate.createMany({ data: templates });
    console.log("Seed terminé: 10 PropertyTemplate créés.");
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
