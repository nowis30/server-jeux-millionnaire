const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const [total, easy, medium, hard] = await Promise.all([
      prisma.quizQuestion.count(),
      prisma.quizQuestion.count({ where: { difficulty: 'easy' } }),
      prisma.quizQuestion.count({ where: { difficulty: 'medium' } }),
      prisma.quizQuestion.count({ where: { difficulty: 'hard' } })
    ]);
    
    console.log('📊 Questions dans la base:');
    console.log('Total:', total);
    console.log('Easy:', easy);
    console.log('Medium:', medium);
    console.log('Hard:', hard);
    
    // Afficher quelques exemples de questions pour voir la diversité
    console.log('\n📝 Exemples de questions easy:');
    const sampleEasy = await prisma.quizQuestion.findMany({
      where: { difficulty: 'easy' },
      take: 5,
      select: { question: true, createdAt: true }
    });
    sampleEasy.forEach((q, i) => {
      console.log(`${i + 1}. ${q.question.substring(0, 80)}...`);
    });
    
    await prisma.$disconnect();
  } catch (err) {
    console.error('Erreur:', err);
    await prisma.$disconnect();
    process.exit(1);
  }
})();
