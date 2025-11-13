const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const targetMigration = '20251113071803_add_drag_racing_fields';
  console.log('[prisma:resolve-failed] Starting cleanup for', targetMigration);

  // Supprime toute entrée de migration portant ce nom, qu'elle soit finie ou non
  const result = await prisma.$executeRaw`
    DELETE FROM "_prisma_migrations"
    WHERE migration_name = ${targetMigration}
  `;

  if (typeof result === 'number' && result > 0) {
    console.log(`[prisma:resolve-failed] Removed migration entries: ${result}`);
  } else {
    console.log('[prisma:resolve-failed] No matching migration entry to remove.');
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
