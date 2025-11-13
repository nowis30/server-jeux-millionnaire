const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const targetMigration = '20251113071803_add_drag_racing_fields';
  console.log('[prisma:resolve-failed] Starting cleanup. Target (if present):', targetMigration);

  try {
    // 1) Lister les migrations incomplètes (bloquées)
    const pending = await prisma.$queryRaw`
      SELECT id, migration_name, started_at, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      WHERE (finished_at IS NULL AND started_at IS NOT NULL)
         OR (rolled_back_at IS NOT NULL)
      ORDER BY started_at DESC NULLS LAST
    `;
    if (Array.isArray(pending) && pending.length) {
      console.log('[prisma:resolve-failed] Incomplete/rolled-back migrations found:', pending.map(p => p.migration_name));
    } else {
      console.log('[prisma:resolve-failed] No incomplete/rolled-back migrations found.');
    }

    // 2) Supprimer toute entrée incomplète/rollback
    const removedIncomplete = await prisma.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE (finished_at IS NULL AND started_at IS NOT NULL)
         OR (rolled_back_at IS NOT NULL)
    `;
    console.log(`[prisma:resolve-failed] Removed incomplete/rolled-back entries: ${Number(removedIncomplete) || 0}`);

    // 3) Supprimer explicitement la migration drag si elle existe
    const removedDrag = await prisma.$executeRaw`
      DELETE FROM "_prisma_migrations"
      WHERE migration_name = ${targetMigration}
    `;
    console.log(`[prisma:resolve-failed] Removed target migration entries: ${Number(removedDrag) || 0}`);

    // 4) Supprimer toute migration contenant 'drag' si d'autres noms ont été générés différemment
    const removedLike = await prisma.$executeRawUnsafe(
      'DELETE FROM "_prisma_migrations" WHERE migration_name LIKE $1',
      '%drag%'
    );
    console.log(`[prisma:resolve-failed] Removed LIKE %drag% entries: ${Number(removedLike) || 0}`);

  } catch (err) {
    console.error('[prisma:resolve-failed] Cleanup error:', err);
  }
}

main()
  .catch((error) => {
    console.error('[prisma:resolve-failed] Failed to resolve migration state', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
