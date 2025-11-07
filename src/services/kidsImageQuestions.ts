import { prisma } from "../prisma";

// Questions enfant basées sur des images locales. Chaque question est conçue pour que l'image soit nécessaire.
// Images à placer côté client dans /public/images/quiz/kids/
// Format QuizQuestion: question, optionA..D, correctAnswer, difficulty='easy', category='kids', imageUrl

interface KidImageQuestionSeed {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: 'A'|'B'|'C'|'D';
  imageFile: string; // relatif sous /images/quiz/kids/
}

const KID_IMAGE_QUESTION_SEEDS: KidImageQuestionSeed[] = [
  {
    question: "Quel animal vois-tu sur l'image ?",
    optionA: "Lion",
    optionB: "Tigre",
    optionC: "Chien",
    optionD: "Ours",
    correctAnswer: 'A',
    imageFile: 'lion.svg'
  },
  {
    question: "Quel animal est montré ?",
    optionA: "Chat",
    optionB: "Cheval",
    optionC: "Vache",
    optionD: "Lapin",
    correctAnswer: 'A',
    imageFile: 'chat.svg'
  },
  {
    question: "Quel monument apparaît sur l'image ?",
    optionA: "Tour Eiffel",
    optionB: "Pyramide",
    optionC: "Colisée",
    optionD: "Statue de la Liberté",
    correctAnswer: 'A',
    imageFile: 'tour-eiffel.svg'
  },
  {
    question: "Quel fruit vois-tu ?",
    optionA: "Pomme",
    optionB: "Banane",
    optionC: "Raisin",
    optionD: "Orange",
    correctAnswer: 'A',
    imageFile: 'pomme.svg'
  },
  {
    question: "Quel objet rond est sur l'image ?",
    optionA: "Ballon",
    optionB: "Livre",
    optionC: "Boîte",
    optionD: "Balle de tennis",
    correctAnswer: 'A',
    imageFile: 'ballon.svg'
  },
  {
    question: "Que voit-on voler ?",
    optionA: "Avion",
    optionB: "Voiture",
    optionC: "Train",
    optionD: "Bateau",
    correctAnswer: 'A',
    imageFile: 'avion.svg'
  },
  {
    question: "Que vois-tu sur l'image ?",
    optionA: "Montagne",
    optionB: "Plage",
    optionC: "Désert",
    optionD: "Forêt",
    correctAnswer: 'A',
    imageFile: 'montagne.svg'
  }
];

/**
 * Insère les questions enfants liées à des images locales si elles n'existent pas encore.
 * Critère d'unicité simple: texte de la question + imageUrl.
 */
export async function ensureKidsImageQuestions(): Promise<{ inserted: number; totalKidsImages: number }> {
  let inserted = 0;
  for (const seed of KID_IMAGE_QUESTION_SEEDS) {
    const imageUrl = `/images/quiz/kids/${seed.imageFile}`;
    const exists = await prisma.quizQuestion.findFirst({
      where: { question: seed.question, imageUrl }
    });
    if (exists) continue;
    try {
      await prisma.quizQuestion.create({
        data: {
          question: seed.question,
          optionA: seed.optionA,
          optionB: seed.optionB,
          optionC: seed.optionC,
          optionD: seed.optionD,
          correctAnswer: seed.correctAnswer,
          difficulty: 'easy',
          category: 'kids',
          imageUrl,
        }
      });
      inserted++;
    } catch (e: any) {
      console.error('[kids-image-questions] Erreur insertion:', e.message);
    }
  }
  const totalKidsImages = await prisma.quizQuestion.count({ where: { category: 'kids', difficulty: 'easy', imageUrl: { contains: '/kids/' } } });
  return { inserted, totalKidsImages };
}

/**
 * Sélectionne une question enfant ayant une image locale prioritairement.
 */
export async function selectKidImageQuestion(playerId: string): Promise<any | null> {
  // Chercher questions enfants easy avec image /kids/ non encore vues
  const seen = await prisma.quizQuestionSeen.findMany({
    where: { playerId, question: { difficulty: 'easy', category: { in: ['kids','enfants'] }, imageUrl: { contains: '/kids/' } } },
    select: { questionId: true }
  });
  const seenIds = seen.map(s => s.questionId);
  const remainingCount = await prisma.quizQuestion.count({
    where: { difficulty: 'easy', category: { in: ['kids','enfants'] }, imageUrl: { contains: '/kids/' }, id: { notIn: seenIds } }
  });
  if (remainingCount === 0) return null;
  const skip = Math.floor(Math.random() * remainingCount);
  return prisma.quizQuestion.findFirst({
    where: { difficulty: 'easy', category: { in: ['kids','enfants'] }, imageUrl: { contains: '/kids/' }, id: { notIn: seenIds } },
    skip
  });
}
