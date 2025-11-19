const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

prisma.quizQuestion.count()
  .then(count => {
    console.log('✓ Questions locales:', count);
  })
  .finally(() => prisma.$disconnect());
