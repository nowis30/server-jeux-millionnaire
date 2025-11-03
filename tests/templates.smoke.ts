import { prisma } from "../src/prisma";
import { ensureTemplateListings, listListings } from "../src/services/listings";

async function main() {
  // S'assurer qu'il y a au moins 50 templates (requiert d'avoir exécuté les migrations + seed)
  const templates = await prisma.propertyTemplate.findMany();
  console.log("Templates count:", templates.length);
  if (templates.length < 50) throw new Error("Moins de 50 templates disponibles (seed manquant)");

  // Créer une partie de test
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const game = await prisma.game.create({ data: { code: `TEMP${suffix}`, status: "running" } });

  // Faire tourner et remplir les listings depuis la banque
  await ensureTemplateListings(game.id, 12, 12); // première fois: remplir 12
  const listings1 = await listListings(game.id);
  const templateListings1 = listings1.filter((l: { templateId: string | null }) => !!l.templateId);
  if (templateListings1.length < 12) throw new Error("Moins de 12 listings de templates après ensureTemplateListings");

  // Rotation: on demande d'en retirer/ajouter 2
  await ensureTemplateListings(game.id, 12, 2);
  const listings2 = await listListings(game.id);
  const templateListings2 = listings2.filter((l: { templateId: string | null }) => !!l.templateId);
  if (templateListings2.length < 12) throw new Error("Le nombre de listings est descendu sous 12 après rotation");

  console.log("SMOKE TEMPLATES/LISTINGS: PASS", { gameId: game.id, listings: templateListings2.length });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("SMOKE TEMPLATES/LISTINGS: FAIL", err);
  process.exit(1);
});