import { prisma } from "../src/prisma";
import { replenishIfLow } from "../src/services/aiQuestions";

async function main() {
  console.log("[Purge] Lecture des compteurs…");
  const totalBefore = await prisma.quizQuestion.count();
  const usedBefore = await prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then(r => r.length);
  const remainingBefore = Math.max(0, totalBefore - usedBefore);
  console.log(`[Purge] Avant: total=${totalBefore}, used=${usedBefore}, remaining=${remainingBefore}`);

  console.log("[Purge] Sélection jusqu'à 250 questions sans tentative…");
  const deletable = await prisma.quizQuestion.findMany({
    where: { attempts: { none: {} } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 250,
  });

  if (deletable.length === 0) {
    console.log("[Purge] Aucune question sans tentative à supprimer.");
  } else {
    const ids = deletable.map(d => d.id);
    const del = await prisma.quizQuestion.deleteMany({ where: { id: { in: ids } } });
    console.log(`[Purge] Supprimé: ${del.count} question(s).`);
  }

  const totalAfter = await prisma.quizQuestion.count();
  const usedAfter = await prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then(r => r.length);
  const remainingAfter = Math.max(0, totalAfter - usedAfter);
  console.log(`[Purge] Après: total=${totalAfter}, used=${usedAfter}, remaining=${remainingAfter}`);

  console.log("[Purge] Déclenchement réappro si nécessaire (threshold=100)…");
  const { remaining, created } = await replenishIfLow(100);
  console.log(`[Purge] Replenish: remainingBefore=${remaining}, created=${created}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[Purge] Erreur:", err);
  process.exit(1);
});
