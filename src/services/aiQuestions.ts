import OpenAI from "openai";
import { prisma } from "../prisma";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

interface GeneratedQuestion {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: 'A' | 'B' | 'C' | 'D';
  difficulty: 'easy' | 'medium' | 'hard';
  category: 'finance' | 'economy' | 'real-estate';
}

const SYSTEM_PROMPT = `Tu es un expert en finance, économie et immobilier. Tu crées des questions de quiz pour un jeu de simulation économique appelé "Héritier Millionnaire".

Le jeu contient :
- Un marché boursier avec 5 actifs (SP500, QQQ, TSX, GLD, TLT)
- De l'immobilier (achat, vente, refinancement, hypothèques)
- Des dividendes trimestriels
- Des taux hypothécaires variables (2% à 7%)
- Un système de quiz "Quitte ou Double"

Génère des questions pertinentes et éducatives. Les questions doivent être :
- Claires et précises
- Adaptées au niveau de difficulté demandé
- Réalistes et basées sur des concepts financiers réels
- Intéressantes et engageantes

Format de réponse OBLIGATOIRE (JSON valide):
{
  "questions": [
    {
      "question": "Texte de la question",
      "optionA": "Première option",
      "optionB": "Deuxième option",
      "optionC": "Troisième option",
      "optionD": "Quatrième option",
      "correctAnswer": "A",
      "difficulty": "easy",
      "category": "finance",
      "explanation": "Courte explication de la bonne réponse"
    }
  ]
}`;

const difficultyPrompts = {
  easy: "Questions simples sur les concepts de base (définitions, règles du jeu, symboles boursiers). Niveau débutant.",
  medium: "Questions intermédiaires nécessitant réflexion (calculs simples, stratégies de base, comparaisons). Niveau intermédiaire.",
  hard: "Questions avancées et complexes (calculs détaillés, stratégies optimales, concepts avancés). Niveau expert."
};

const categoryPrompts = {
  finance: "Marché boursier, actions, obligations, dividendes, rendements, symboles (SP500, QQQ, TSX, GLD, TLT)",
  economy: "Économie du jeu, mécaniques, stratégies, taux d'intérêt, inflation, cycles économiques",
  'real-estate': "Immobilier, hypothèques, refinancement, appréciation, loyers, taxes, maintenance"
};

/**
 * Génère des questions via l'API OpenAI
 */
export async function generateQuestionsWithAI(
  difficulty: 'easy' | 'medium' | 'hard',
  category: 'finance' | 'economy' | 'real-estate',
  count: number = 5
): Promise<GeneratedQuestion[]> {
  
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[AI] OPENAI_API_KEY non configurée, génération IA désactivée");
    return [];
  }

  try {
    const userPrompt = `Génère exactement ${count} questions de difficulté "${difficulty}" dans la catégorie "${category}".

Difficulté : ${difficultyPrompts[difficulty]}
Catégorie : ${categoryPrompts[category]}

Assure-toi que :
1. Les 4 options sont plausibles
2. Une seule réponse est correcte
3. Les questions sont variées
4. Le français est impeccable
5. Le format JSON est valide

Réponds UNIQUEMENT avec le JSON, sans texte avant ou après.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Modèle économique et performant
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.8, // Créativité modérée
      max_tokens: 2000,
      response_format: { type: "json_object" }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Pas de réponse de l'IA");
    }

    const parsed = JSON.parse(content);
    const questions = parsed.questions || [];

    // Validation basique
    const validQuestions = questions.filter((q: any) => 
      q.question && 
      q.optionA && q.optionB && q.optionC && q.optionD &&
      ['A', 'B', 'C', 'D'].includes(q.correctAnswer) &&
      ['easy', 'medium', 'hard'].includes(q.difficulty) &&
      ['finance', 'economy', 'real-estate'].includes(q.category)
    );

    console.log(`[AI] ${validQuestions.length}/${count} questions générées avec succès`);
    return validQuestions;

  } catch (error: any) {
    console.error("[AI] Erreur génération questions:", error.message);
    return [];
  }
}

/**
 * Génère et sauvegarde de nouvelles questions dans la base
 */
export async function generateAndSaveQuestions(): Promise<number> {
  console.log("[AI] Démarrage génération automatique de questions...");

  try {
    // Générer un mélange de questions
    const batches = [
      { difficulty: 'easy' as const, category: 'finance' as const, count: 2 },
      { difficulty: 'easy' as const, category: 'economy' as const, count: 1 },
      { difficulty: 'medium' as const, category: 'finance' as const, count: 2 },
      { difficulty: 'medium' as const, category: 'real-estate' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'finance' as const, count: 1 },
      { difficulty: 'hard' as const, category: 'economy' as const, count: 1 },
    ];

    let totalCreated = 0;

    for (const batch of batches) {
      const questions = await generateQuestionsWithAI(batch.difficulty, batch.category, batch.count);
      
      for (const q of questions) {
        try {
          await prisma.quizQuestion.create({
            data: {
              question: q.question,
              optionA: q.optionA,
              optionB: q.optionB,
              optionC: q.optionC,
              optionD: q.optionD,
              correctAnswer: q.correctAnswer,
              difficulty: q.difficulty,
              category: q.category,
            }
          });
          totalCreated++;
        } catch (err) {
          console.error("[AI] Erreur sauvegarde question:", err);
        }
      }

      // Pause entre les batches pour éviter rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`[AI] ${totalCreated} nouvelles questions créées`);

    // Rotation : garder max 100 questions par difficulté
    await rotateQuestions();

    return totalCreated;

  } catch (error: any) {
    console.error("[AI] Erreur génération et sauvegarde:", error.message);
    return 0;
  }
}

/**
 * Rotation des questions : supprime les plus anciennes si trop nombreuses
 */
async function rotateQuestions() {
  const MAX_PER_DIFFICULTY = 50; // Max 50 questions par niveau

  for (const difficulty of ['easy', 'medium', 'hard']) {
    const count = await prisma.quizQuestion.count({ where: { difficulty } });
    
    if (count > MAX_PER_DIFFICULTY) {
      const toDelete = count - MAX_PER_DIFFICULTY;
      
      // Supprimer les plus anciennes
      const oldest = await prisma.quizQuestion.findMany({
        where: { difficulty },
        orderBy: { createdAt: 'asc' },
        take: toDelete,
        select: { id: true }
      });

      await prisma.quizQuestion.deleteMany({
        where: { id: { in: oldest.map(q => q.id) } }
      });

      console.log(`[AI] ${toDelete} anciennes questions ${difficulty} supprimées`);
    }
  }
}

/**
 * Test de génération (pour debug)
 */
export async function testAIGeneration() {
  console.log("[AI] Test génération...");
  const questions = await generateQuestionsWithAI('medium', 'finance', 2);
  console.log(JSON.stringify(questions, null, 2));
}
