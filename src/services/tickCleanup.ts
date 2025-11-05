import { prisma } from "../prisma";

/**
 * Nettoie les ticks de marché pour une partie donnée
 * Garde les 100 derniers ticks + 1 sur 100 des anciens ticks
 * @param gameId - ID de la partie
 * @returns Nombre total de ticks supprimés
 */
export async function cleanupMarketTicks(gameId: string): Promise<number> {
  let totalDeleted = 0;
  const symbols = ["SP500", "QQQ", "TSX", "GLD", "TLT"];
  
  for (const symbol of symbols) {
    // 1. Récupérer tous les ticks triés par date décroissante
    const allTicks = await prisma.marketTick.findMany({
      where: { gameId, symbol },
      orderBy: { at: "desc" },
      select: { id: true, at: true },
    });
    
    if (allTicks.length <= 100) {
      continue; // Pas assez de ticks pour nettoyer
    }
    
    // 2. Garder les 100 derniers (plus récents)
    const keepRecent = allTicks.slice(0, 100).map(t => t.id);
    
    // 3. Pour les anciens (index 100+), garder 1 sur 100
    const oldTicks = allTicks.slice(100);
    const keepSampled = oldTicks
      .filter((_, index) => index % 100 === 0)
      .map(t => t.id);
    
    // 4. Combiner les deux listes
    const keepIds = [...keepRecent, ...keepSampled];
    
    // 5. Supprimer tous les autres
    const result = await prisma.marketTick.deleteMany({
      where: {
        gameId,
        symbol,
        id: { notIn: keepIds },
      },
    });
    
    totalDeleted += result.count;
    
    console.log(`[cleanupTicks] ${symbol}: ${allTicks.length} total, ${keepIds.length} gardés, ${result.count} supprimés`);
  }
  
  return totalDeleted;
}
