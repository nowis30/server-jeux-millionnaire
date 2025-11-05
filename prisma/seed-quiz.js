const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const questions = [
  // ========== QUESTIONS FACILES (5) ==========
  {
    question: "Quel est le taux d'intérêt hypothécaire de base au début du jeu?",
    optionA: "3%",
    optionB: "5%",
    optionC: "7%",
    optionD: "10%",
    correctAnswer: "B",
    difficulty: "easy",
    category: "real-estate"
  },
  {
    question: "Dans quel marché investit-on avec le symbole SP500?",
    optionA: "Actions canadiennes",
    optionB: "Obligations",
    optionC: "Actions américaines (S&P 500)",
    optionD: "Or",
    correctAnswer: "C",
    difficulty: "easy",
    category: "finance"
  },
  {
    question: "Que signifie 'refinancer' une propriété?",
    optionA: "Vendre la propriété",
    optionB: "Emprunter en utilisant la valeur de la propriété",
    optionC: "Augmenter le loyer",
    optionD: "Faire des réparations",
    correctAnswer: "B",
    difficulty: "easy",
    category: "real-estate"
  },
  {
    question: "À quelle fréquence les dividendes sont-ils versés dans le jeu?",
    optionA: "Mensuellement",
    optionB: "Trimestriellement",
    optionC: "Annuellement",
    optionD: "Hebdomadairement",
    correctAnswer: "B",
    difficulty: "easy",
    category: "finance"
  },
  {
    question: "Quel symbole représente l'or dans le marché boursier du jeu?",
    optionA: "TSX",
    optionB: "TLT",
    optionC: "GLD",
    optionD: "QQQ",
    correctAnswer: "C",
    difficulty: "easy",
    category: "finance"
  },
  
  // ========== QUESTIONS MOYENNES (5) ==========
  {
    question: "Quelle est la plage de variation annuelle de l'appréciation immobilière?",
    optionA: "0% à 3%",
    optionB: "2% à 5%",
    optionC: "5% à 10%",
    optionD: "10% à 15%",
    correctAnswer: "B",
    difficulty: "medium",
    category: "real-estate"
  },
  {
    question: "Combien de temps doit-on attendre entre deux sessions de quiz?",
    optionA: "30 minutes",
    optionB: "60 minutes",
    optionC: "2 heures",
    optionD: "24 heures",
    correctAnswer: "B",
    difficulty: "medium",
    category: "economy"
  },
  {
    question: "Dans quelle plage varie le taux hypothécaire dans le jeu?",
    optionA: "1% à 5%",
    optionB: "2% à 7%",
    optionC: "3% à 10%",
    optionD: "5% à 12%",
    correctAnswer: "B",
    difficulty: "medium",
    category: "real-estate"
  },
  {
    question: "Quel actif représente les obligations américaines dans le jeu?",
    optionA: "GLD",
    optionB: "TSX",
    optionC: "TLT",
    optionD: "SP500",
    correctAnswer: "C",
    difficulty: "medium",
    category: "finance"
  },
  {
    question: "À quelle fréquence un tick de marché est-il généré?",
    optionA: "Toutes les 5 secondes",
    optionB: "Toutes les 10 secondes",
    optionC: "Toutes les 30 secondes",
    optionD: "Toutes les minutes",
    correctAnswer: "B",
    difficulty: "medium",
    category: "finance"
  },
  
  // ========== QUESTIONS DIFFICILES (10+) ==========
  {
    question: "Combien de ticks de marché sont conservés au minimum après le nettoyage automatique?",
    optionA: "50 ticks par symbole",
    optionB: "100 ticks par symbole",
    optionC: "200 ticks par symbole",
    optionD: "500 ticks par symbole",
    correctAnswer: "B",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Quel est le principe du système 'Quitte ou Double' du quiz?",
    optionA: "On peut arrêter et encaisser à tout moment",
    optionB: "On doit répondre à toutes les questions",
    optionC: "Les gains sont fixes",
    optionD: "On ne peut pas perdre",
    correctAnswer: "A",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Combien d'années simulées représente une heure de jeu réel avec les ticks accélérés?",
    optionA: "6 mois",
    optionB: "1 an",
    optionC: "Environ 1.4 ans",
    optionD: "2 ans",
    correctAnswer: "C",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Quel est le palier de sécurité après les 5 premières questions?",
    optionA: "$1,000",
    optionB: "$5,000",
    optionC: "$10,000",
    optionD: "$50,000",
    correctAnswer: "B",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Quelle est la fréquence de nettoyage automatique des ticks?",
    optionA: "Toutes les 10 minutes",
    optionB: "Toutes les 20 minutes",
    optionC: "Toutes les heures",
    optionD: "Une fois par jour",
    correctAnswer: "B",
    difficulty: "hard",
    category: "economy"
  },

  // Questions supplémentaires faciles
  {
    question: "Quel est le montant de départ en cash pour chaque joueur?",
    optionA: "$500,000",
    optionB: "$1,000,000",
    optionC: "$2,000,000",
    optionD: "$5,000,000",
    correctAnswer: "B",
    difficulty: "easy",
    category: "economy"
  },
  {
    question: "Combien d'actifs boursiers sont disponibles dans le jeu?",
    optionA: "3",
    optionB: "5",
    optionC: "10",
    optionD: "20",
    correctAnswer: "B",
    difficulty: "easy",
    category: "finance"
  },
  {
    question: "Quel symbole représente le marché canadien (TSX)?",
    optionA: "SP500",
    optionB: "QQQ",
    optionC: "TSX",
    optionD: "GLD",
    correctAnswer: "C",
    difficulty: "easy",
    category: "finance"
  },
  {
    question: "Quelle action augmente directement votre netWorth?",
    optionA: "Acheter une propriété",
    optionB: "Refinancer",
    optionC: "Répondre correctement au quiz",
    optionD: "Toutes ces réponses",
    correctAnswer: "D",
    difficulty: "easy",
    category: "economy"
  },
  {
    question: "Que se passe-t-il si on répond incorrectement à une question?",
    optionA: "On perd tout",
    optionB: "On retombe au dernier palier",
    optionC: "On peut réessayer",
    optionD: "On perd 50% des gains",
    correctAnswer: "B",
    difficulty: "easy",
    category: "economy"
  },

  // Questions supplémentaires moyennes
  {
    question: "QQQ représente quel type d'investissement?",
    optionA: "Obligations",
    optionB: "Or",
    optionC: "Actions technologiques (Nasdaq)",
    optionD: "Immobilier",
    correctAnswer: "C",
    difficulty: "medium",
    category: "finance"
  },
  {
    question: "Quel est l'impact d'une augmentation des taux hypothécaires?",
    optionA: "Augmente le paiement mensuel",
    optionB: "Réduit la valeur des propriétés",
    optionC: "Rend l'emprunt plus coûteux",
    optionD: "Toutes ces réponses",
    correctAnswer: "D",
    difficulty: "medium",
    category: "real-estate"
  },
  {
    question: "Combien de logements peut contenir une propriété dans le jeu?",
    optionA: "Toujours 1",
    optionB: "Entre 1 et plusieurs (varie)",
    optionC: "Toujours 10",
    optionD: "Entre 50 et 100",
    correctAnswer: "B",
    difficulty: "medium",
    category: "real-estate"
  },
  {
    question: "Quelle est la durée standard d'un prêt hypothécaire dans le jeu?",
    optionA: "15 ans",
    optionB: "25 ans",
    optionC: "30 ans",
    optionD: "40 ans",
    correctAnswer: "B",
    difficulty: "medium",
    category: "real-estate"
  },
  {
    question: "Quel événement peut augmenter les coûts de maintenance?",
    optionA: "Bris mineur",
    optionB: "Bris majeur",
    optionC: "Rénovation nécessaire",
    optionD: "Toutes ces réponses",
    correctAnswer: "D",
    difficulty: "medium",
    category: "real-estate"
  },

  // Questions supplémentaires difficiles
  {
    question: "Quel est le ratio d'échantillonnage pour les anciens ticks de marché?",
    optionA: "1 sur 10",
    optionB: "1 sur 50",
    optionC: "1 sur 100",
    optionD: "1 sur 1000",
    correctAnswer: "C",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Combien de ticks de marché sont générés par heure?",
    optionA: "60",
    optionB: "180",
    optionC: "360",
    optionD: "720",
    correctAnswer: "C",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Quel est le cache TTL (Time To Live) pour les endpoints marché?",
    optionA: "30 secondes",
    optionB: "60 secondes",
    optionC: "90 secondes",
    optionD: "120 secondes",
    correctAnswer: "C",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "À quelle fréquence les taux hypothécaires sont-ils ajustés?",
    optionA: "Chaque semaine",
    optionB: "Le 1er de chaque mois",
    optionC: "Chaque trimestre",
    optionD: "Une fois par an",
    correctAnswer: "B",
    difficulty: "hard",
    category: "real-estate"
  },
  {
    question: "De combien varie le taux hypothécaire chaque ajustement?",
    optionA: "±0.10%",
    optionB: "±0.25%",
    optionC: "±0.50%",
    optionD: "±1.00%",
    correctAnswer: "B",
    difficulty: "hard",
    category: "real-estate"
  },
  {
    question: "Combien y a-t-il de questions difficiles dans une session complète de quiz?",
    optionA: "3",
    optionB: "5",
    optionC: "Illimité jusqu'à échec ou cash-out",
    optionD: "10",
    correctAnswer: "C",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Quel est le deuxième palier de sécurité après 10 questions?",
    optionA: "$10,000",
    optionB: "$25,000",
    optionC: "$50,000",
    optionD: "$100,000",
    correctAnswer: "C",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Quelle technologie est utilisée pour les mises à jour en temps réel?",
    optionA: "HTTP Polling",
    optionB: "WebSockets (Socket.IO)",
    optionC: "Server-Sent Events",
    optionD: "Long Polling",
    correctAnswer: "B",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Quel est le multiplicateur moyen entre chaque question difficile?",
    optionA: "x1.5",
    optionB: "x2",
    optionC: "Variable (augmentation progressive)",
    optionD: "x10",
    correctAnswer: "C",
    difficulty: "hard",
    category: "economy"
  },
  {
    question: "Combien de temps le JWT admin est-il valide?",
    optionA: "1 heure",
    optionB: "6 heures",
    optionC: "12 heures",
    optionD: "24 heures",
    correctAnswer: "C",
    difficulty: "hard",
    category: "economy"
  }
];

async function seedQuizQuestions() {
  console.log("🌱 Seeding quiz questions...\n");

  try {
    // Supprimer les anciennes questions si elles existent
    await prisma.quizQuestion.deleteMany({});
    console.log("✓ Anciennes questions supprimées\n");

    // Insérer les nouvelles questions
    for (const q of questions) {
      await prisma.quizQuestion.create({ data: q });
    }

    console.log(`✅ ${questions.length} questions créées avec succès!\n`);

    // Statistiques
    const easy = questions.filter(q => q.difficulty === 'easy').length;
    const medium = questions.filter(q => q.difficulty === 'medium').length;
    const hard = questions.filter(q => q.difficulty === 'hard').length;

    console.log("📊 Répartition:");
    console.log(`   Faciles: ${easy}`);
    console.log(`   Moyennes: ${medium}`);
    console.log(`   Difficiles: ${hard}`);

  } catch (error) {
    console.error("❌ Erreur lors du seeding:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

seedQuizQuestions();
