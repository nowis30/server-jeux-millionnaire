const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const targetMigration = '20251113071803_add_drag_racing_fields';

  const result = await prisma.$executeRaw`
    DELETE FROM "_prisma_migrations"
    WHERE migration_name = ${targetMigration}
      AND finished_at IS NULL
  `;

  if (typeof result === 'number' && result > 0) {
    console.log(`Removed failed migration entry: ${targetMigration}`);
  } else {
    console.log('No failed migration entry to remove.');
  }
}

main()
  .catch((error) => {
    console.error('Failed to resolve migration state', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
