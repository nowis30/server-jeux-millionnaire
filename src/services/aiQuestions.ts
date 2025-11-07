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
  category: 'finance' | 'economy' | 'real-estate' | 'business' | 'technology' | 'science' | 'history' | 'geography' | 'sports' | 'arts' | 'cinema' | 'music' | 'literature' | 'culture' | 'nature' | 'health' | 'food' | 'general' | 'animals' | 'translation' | 'kids' | 'enfants';
  imageUrl?: string; // URL optionnelle d'une image illustrant la question
}

const SYSTEM_PROMPT = `Tu es un expert universel en culture générale. Tu crées des questions de quiz variées et passionnantes sur TOUS les sujets imaginables.

Catégories disponibles:
- finance, economy, real-estate: Finance, économie, immobilier, marché boursier
- business: Entrepreneuriat, management, commerce, marketing
- technology: Informatique, innovations, gadgets, intelligence artificielle
- science: Physique, chimie, biologie, astronomie, mathématiques
- history: Histoire mondiale, événements marquants, personnalités historiques
- geography: Pays, capitales, montagnes, océans, continents
- sports: Football, olympiques, records, athlètes célèbres
- arts: Peinture, sculpture, architecture, arts visuels
- cinema: Films, réalisateurs, acteurs, oscars
- music: Artistes, albums, genres musicaux, instruments
- literature: Livres, auteurs, poésie, œuvres classiques
- culture: Traditions, coutumes, gastronomie, langues
- nature: Animaux, plantes, environnement, écosystèmes
- health: Santé, nutrition, bien-être, anatomie
- food: Cuisine, recettes, gastronomie, ingrédients
- general: Culture générale variée, faits intéressants
- animals: Zoologie, espèces, habitats, comportements, chaînes alimentaires
- translation: Traduction FR/EN, faux amis, synonymes, expressions courantes
 - kids, enfants: Questions pour enfants (6–9 ans), vocabulaire simple, monde concret, thèmes ludiques

Pour certaines questions, tu peux ajouter une image pour illustrer (personnage historique, monument, animal, œuvre d'art, etc.). Utilise des URLs d'images Unsplash ou Pexels en haute qualité.

Génère des questions qui sont :
- Claires et précises
- Adaptées au niveau de difficulté demandé
- Intéressantes et engageantes
- Éducatives et basées sur des faits réels
- Diversifiées (pas seulement finance/économie)

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
      "category": "history",
      "imageUrl": "https://images.unsplash.com/photo-xxx",
      "explanation": "Courte explication de la bonne réponse"
    }
  ]
}

IMPORTANT pour imageUrl:
- Utilise des URLs Unsplash (https://images.unsplash.com/photo-...) ou Pexels
- Seulement si l'image ajoute de la valeur (monument, personne, animal, œuvre)
- Laisse vide si pas nécessaire
- Images haute qualité et pertinentes uniquement`;

// Prompt spécifique pour ENFANTS (6-9 ans)
const KIDS_SYSTEM_PROMPT = `Tu es un pédagogue qui crée des questions de quiz pour des enfants de 6 à 9 ans.

Objectifs:
- Questions TRÈS simples, une seule idée par question
- Mots courts, phrases courtes, sans jargon
- 4 options claires; une seule est correcte
- Ton bienveillant, ludique, zéro piège

Thèmes variés (mixe-les au fil des questions):
- Couleurs (rouge/bleu/vert/jaune, associer objets/couleurs)
- Nombres 1–10 (compter, comparer, simple addition 1 chiffre)
- Jours de la semaine (lundi → dimanche), saisons (printemps/été/automne/hiver)
- Formes (cercle, carré, triangle, rectangle)
- Météo (pluie, soleil, neige, vent)
- Animaux familiers (chat, chien, oiseau, poisson) et nature proche
- Objets du quotidien (pomme, ballon, livre, chaise)
- Émotions simples (content, triste), routines (matin/soir)

Contraintes:
- Difficulté: "easy" uniquement
- Catégorie: "kids" (ou "enfants" acceptable)
- Pas d'images (laisse imageUrl vide)
- Français simple et correct

JSON strict au format:
{
  "questions": [
    {
      "question": "...",
      "optionA": "...",
      "optionB": "...",
      "optionC": "...",
      "optionD": "...",
      "correctAnswer": "A",
      "difficulty": "easy",
      "category": "kids"
    }
  ]
}

Réponds UNIQUEMENT le JSON, sans aucun texte avant/après.`;

async function generateKidsQuestionsWithAI(count: number = 10): Promise<GeneratedQuestion[]> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[AI] OPENAI_API_KEY non configurée (kids), génération IA désactivée");
    return [];
  }
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: KIDS_SYSTEM_PROMPT },
        { role: "user", content: `Génère exactement ${count} questions.` }
      ],
      temperature: 0.7,
      max_tokens: 2000,
      response_format: { type: "json_object" }
    });
    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("Pas de réponse de l'IA (kids)");
    const parsed = JSON.parse(content);
    const questions = parsed.questions || [];
    const valid = questions.filter((q: any) =>
      q.question && q.optionA && q.optionB && q.optionC && q.optionD &&
      ['A','B','C','D'].includes(q.correctAnswer) &&
      q.difficulty === 'easy' && (q.category === 'kids' || q.category === 'enfants')
    );
    return valid as GeneratedQuestion[];
  } catch (e: any) {
    console.error("[AI] Erreur génération kids:", e.message);
    return [];
  }
}

const difficultyPrompts = {
  easy: "Questions simples sur les concepts de base (définitions, règles du jeu, symboles boursiers). Niveau débutant.",
  medium: "Questions intermédiaires nécessitant réflexion (calculs simples, stratégies de base, comparaisons). Niveau intermédiaire.",
  hard: "Questions avancées et complexes (calculs détaillés, stratégies optimales, concepts avancés). Niveau expert."
};

export const allowedCategories = [
  'finance','economy','real-estate','business','technology','science','history','geography','sports','arts','cinema','music','literature','culture','nature','health','food','general','animals','translation','kids','enfants'
] as const;

const categoryPrompts = {
  finance: "Marché boursier, actions, obligations, dividendes, rendements, investissements",
  economy: "Économie, taux d'intérêt, inflation, PIB, commerce international",
  'real-estate': "Immobilier, hypothèques, propriétés, loyers, valorisation",
  business: "Entrepreneuriat, management, stratégie d'entreprise, marketing, leadership",
  technology: "Informatique, programmation, gadgets, IA, innovations technologiques",
  science: "Physique, chimie, biologie, astronomie, découvertes scientifiques",
  history: "Histoire mondiale, guerres, révolutions, personnages historiques, civilisations",
  geography: "Pays, capitales, montagnes, océans, continents, villes",
  sports: "Football, basketball, olympiques, records sportifs, athlètes",
  arts: "Peinture, sculpture, architecture, mouvements artistiques, musées",
  cinema: "Films cultes, réalisateurs, acteurs, oscars, cinéma mondial",
  music: "Artistes, albums, genres musicaux, instruments, concerts",
  literature: "Romans, poésie, auteurs célèbres, prix littéraires, œuvres classiques",
  culture: "Traditions, gastronomie, langues, coutumes, fêtes",
  nature: "Animaux, plantes, forêts, déserts, biodiversité, écologie",
  health: "Santé, nutrition, exercice, anatomie, maladies, bien-être",
  food: "Cuisine, recettes, ingrédients, restaurants, spécialités culinaires",
  general: "Culture générale, faits intéressants, anecdotes, connaissances diverses",
  animals: "Zoologie, animaux domestiques et sauvages, habitats, chaînes alimentaires, comportements",
  translation: "Traduction français-anglais, faux amis, synonymes, expressions idiomatiques, conjugaison simple",
  kids: "Questions pour enfants très simples: objets du quotidien, animaux familiers, couleurs, chiffres 1-10",
  enfants: "Questions très faciles (6-9 ans): vocabulaire simple, monde concret, réponses évidentes"
};

/**
 * Mélange l'ordre des options de réponse et ajuste correctAnswer
 */
function shuffleAnswers(q: GeneratedQuestion): GeneratedQuestion {
  const options = [
    { letter: 'A', text: q.optionA },
    { letter: 'B', text: q.optionB },
    { letter: 'C', text: q.optionC },
    { letter: 'D', text: q.optionD },
  ];

  // Trouver la bonne réponse avant le mélange
  const correctOption = options.find(opt => opt.letter === q.correctAnswer);
  
  // Mélanger les options (algorithme Fisher-Yates)
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  // Trouver la nouvelle lettre de la bonne réponse
  const newCorrectIndex = options.findIndex(opt => opt.text === correctOption?.text);
  const newCorrectLetter = ['A', 'B', 'C', 'D'][newCorrectIndex] as 'A' | 'B' | 'C' | 'D';

  return {
    ...q,
    optionA: options[0].text,
    optionB: options[1].text,
    optionC: options[2].text,
    optionD: options[3].text,
    correctAnswer: newCorrectLetter,
  };
}

// Image locale par défaut selon la difficulté
// Images désactivées pour le moment
function defaultImageForDifficulty(_diff: 'easy'|'medium'|'hard'): string {
  return '';
}

/**
 * Vérifie si une question similaire existe déjà (éviter les doublons)
 */
async function isDuplicate(question: string): Promise<boolean> {
  // Normaliser le texte pour la comparaison
  const normalized = question.toLowerCase().trim();
  
  // Chercher des questions similaires (même texte ou très proche)
  const existing = await prisma.quizQuestion.findMany({
    select: { question: true }
  });

  for (const q of existing) {
    const existingNormalized = q.question.toLowerCase().trim();
    
    // Vérifier similarité exacte
    if (existingNormalized === normalized) {
      return true;
    }
    
    // Vérifier similarité très proche (90% des mots en commun)
    const words1 = new Set(normalized.split(/\s+/));
    const words2 = new Set(existingNormalized.split(/\s+/));
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    const similarity = intersection.size / union.size;
    
    if (similarity > 0.9) {
      return true;
    }
  }

  return false;
}

/**
 * Génère des questions via l'API OpenAI
 */
export async function generateQuestionsWithAI(
  difficulty: 'easy' | 'medium' | 'hard',
  category: typeof allowedCategories[number],
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

IMPORTANT - Critères de création :
1. Les 4 options doivent être plausibles et crédibles
2. Une seule réponse est correcte
3. Les questions doivent être TRÈS VARIÉES et ORIGINALES
4. Évite les questions trop similaires entre elles
5. Le français doit être impeccable
6. Le format JSON doit être valide
7. Chaque question doit être unique et ne pas ressembler aux autres
8. Varie les types de questions : définitions, calculs, comparaisons, stratégies, etc.

Réponds UNIQUEMENT avec le JSON, sans texte avant ou après.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Modèle économique et performant
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.9, // Plus de créativité pour plus de diversité
      max_tokens: 3000, // Augmenté pour permettre plus de questions
      response_format: { type: "json_object" }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Pas de réponse de l'IA");
    }

    const parsed = JSON.parse(content);
    const questions = parsed.questions || [];

    // Validation basique: autoriser toutes les catégories supportées (pas uniquement finance/économie/immobilier)
    const validQuestions = questions.filter((q: any) => 
      q.question && 
      q.optionA && q.optionB && q.optionC && q.optionD &&
      ['A', 'B', 'C', 'D'].includes(q.correctAnswer) &&
      ['easy', 'medium', 'hard'].includes(q.difficulty) &&
      allowedCategories.includes(q.category)
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
    // Générer des questions diversifiées sur tous les sujets (100 questions total)
    const batches = [
      // Pool enfants dédié (ajout initial pour alimenter Q1-Q4) - petites séries
      { difficulty: 'easy' as const, category: 'kids' as const, count: 6 },
      // Questions faciles (40 questions) - Culture générale accessible
      { difficulty: 'easy' as const, category: 'general' as const, count: 5 },
      { difficulty: 'easy' as const, category: 'geography' as const, count: 4 },
      { difficulty: 'easy' as const, category: 'history' as const, count: 4 },
      { difficulty: 'easy' as const, category: 'sports' as const, count: 4 },
      { difficulty: 'easy' as const, category: 'cinema' as const, count: 3 },
      { difficulty: 'easy' as const, category: 'music' as const, count: 3 },
      { difficulty: 'easy' as const, category: 'science' as const, count: 3 },
  { difficulty: 'easy' as const, category: 'nature' as const, count: 3 },
  { difficulty: 'easy' as const, category: 'animals' as const, count: 3 },
  { difficulty: 'easy' as const, category: 'translation' as const, count: 3 },
      { difficulty: 'easy' as const, category: 'food' as const, count: 3 },
      { difficulty: 'easy' as const, category: 'finance' as const, count: 2 },
      { difficulty: 'easy' as const, category: 'technology' as const, count: 2 },
      { difficulty: 'easy' as const, category: 'arts' as const, count: 2 },
      { difficulty: 'easy' as const, category: 'culture' as const, count: 2 },
      
      // Questions moyennes (35 questions) - Connaissances intermédiaires
      { difficulty: 'medium' as const, category: 'history' as const, count: 4 },
      { difficulty: 'medium' as const, category: 'science' as const, count: 4 },
      { difficulty: 'medium' as const, category: 'literature' as const, count: 3 },
      { difficulty: 'medium' as const, category: 'geography' as const, count: 3 },
      { difficulty: 'medium' as const, category: 'arts' as const, count: 3 },
      { difficulty: 'medium' as const, category: 'business' as const, count: 3 },
      { difficulty: 'medium' as const, category: 'technology' as const, count: 3 },
      { difficulty: 'medium' as const, category: 'cinema' as const, count: 2 },
      { difficulty: 'medium' as const, category: 'sports' as const, count: 2 },
      { difficulty: 'medium' as const, category: 'health' as const, count: 2 },
      { difficulty: 'medium' as const, category: 'economy' as const, count: 2 },
      { difficulty: 'medium' as const, category: 'music' as const, count: 2 },
  { difficulty: 'medium' as const, category: 'nature' as const, count: 2 },
  { difficulty: 'medium' as const, category: 'animals' as const, count: 2 },
  { difficulty: 'medium' as const, category: 'translation' as const, count: 2 },
      
      // Questions difficiles (25 questions) - Expertise requise
      { difficulty: 'hard' as const, category: 'science' as const, count: 4 },
      { difficulty: 'hard' as const, category: 'history' as const, count: 3 },
      { difficulty: 'hard' as const, category: 'literature' as const, count: 3 },
      { difficulty: 'hard' as const, category: 'technology' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'arts' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'finance' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'real-estate' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'business' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'geography' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'economy' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'health' as const, count: 1 },
    ];

    let totalCreated = 0;
    let totalDuplicates = 0;

    for (const batch of batches) {
      console.log(`[AI] Génération: ${batch.count} questions ${batch.difficulty}/${batch.category}...`);
      const questions = await generateQuestionsWithAI(batch.difficulty, batch.category, batch.count);
      
      // Si batch catégorie 'kids': regénérer via prompt dédié pour meilleure qualité enfant
      const effectiveQuestions = batch.category === 'kids'
        ? await generateKidsQuestionsWithAI(batch.count)
        : questions;

      for (const q of effectiveQuestions) {
        try {
          // Vérifier si c'est un doublon
          const duplicate = await isDuplicate(q.question);
          if (duplicate) {
            console.log(`[AI] Question en doublon ignorée: "${q.question.substring(0, 50)}..."`);
            totalDuplicates++;
            continue;
          }

          // Mélanger l'ordre des réponses pour plus de diversité
          const shuffled = shuffleAnswers(q);

          await prisma.quizQuestion.create({
            data: {
              question: shuffled.question,
              optionA: shuffled.optionA,
              optionB: shuffled.optionB,
              optionC: shuffled.optionC,
              optionD: shuffled.optionD,
              correctAnswer: shuffled.correctAnswer,
              difficulty: shuffled.difficulty,
              category: batch.category === 'kids' ? 'kids' : shuffled.category,
              imageUrl: null,
            }
          });
          totalCreated++;
          console.log(`[AI] ✓ Question créée (${totalCreated}): "${shuffled.question.substring(0, 60)}..."`);
        } catch (err: any) {
          console.error("[AI] Erreur sauvegarde question:", err.message);
        }
      }

      // Pause entre les batches pour éviter rate limiting (OpenAI a des limites)
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`[AI] ✅ ${totalCreated} nouvelles questions créées (${totalDuplicates} doublons évités)`);

    // Rotation : garder max 100 questions par difficulté
    await rotateQuestions();

    return totalCreated;

  } catch (error: any) {
    console.error("[AI] Erreur génération et sauvegarde:", error.message);
    return 0;
  }
}

/**
 * Assure un stock minimum de questions ENFANTS (easy, category kids/enfants), sans images.
 * Utilise le prompt dédié enfants pour plus de qualité.
 */
export async function ensureKidsPool(minKids = 450, targetKids = 500): Promise<{ created: number; remaining: number; target: number }> {
  // Calculer le stock enfants restant (non utilisés globalement)
  const kidsCategories = ['kids','enfants'] as const;
  const kidsTotal = await prisma.quizQuestion.count({ where: { category: { in: kidsCategories as any }, difficulty: 'easy' } });
  const kidsUsed = await prisma.quizAttempt.findMany({ where: { question: { category: { in: kidsCategories as any }, difficulty: 'easy' } }, distinct: ["questionId"], select: { questionId: true } }).then(r => r.length);
  const kidsRemaining = Math.max(0, kidsTotal - kidsUsed);

  if (!process.env.OPENAI_API_KEY) {
    console.warn("[AI] OPENAI_API_KEY manquante – ensureKidsPool ne peut pas générer");
    return { created: 0, remaining: kidsRemaining, target: targetKids };
  }

  if (kidsRemaining >= minKids) {
    return { created: 0, remaining: kidsRemaining, target: targetKids };
  }

  const toCreate = Math.max(0, targetKids - kidsRemaining);
  let created = 0;
  const batchSize = 12;
  // Pré-charger les questions enfants existantes pour une déduplication rapide
  const existingKids = await prisma.quizQuestion.findMany({ where: { category: { in: kidsCategories as any }, difficulty: 'easy' }, select: { question: true } });
  const existingSet = new Set(existingKids.map(q => q.question.toLowerCase().trim()));

  for (let i = 0; i < Math.ceil(toCreate / batchSize); i++) {
    try {
      const raw = await generateKidsQuestionsWithAI(Math.min(batchSize, toCreate - created));
      for (const q0 of raw) {
        try {
          const key = q0.question.toLowerCase().trim();
          if (existingSet.has(key)) continue;
          const isDup = await isDuplicate(q0.question);
          if (isDup) continue;
          const shuffled = shuffleAnswers({ ...q0, difficulty: 'easy', category: 'kids' } as any);
          await prisma.quizQuestion.create({
            data: {
              question: shuffled.question,
              optionA: shuffled.optionA,
              optionB: shuffled.optionB,
              optionC: shuffled.optionC,
              optionD: shuffled.optionD,
              correctAnswer: shuffled.correctAnswer,
              difficulty: 'easy',
              category: 'kids',
              imageUrl: null,
            }
          });
          created++;
          existingSet.add(key);
        } catch {}
      }
      // petite pause anti rate-limit
      await new Promise(r => setTimeout(r, 400));
    } catch {}
  }

  return { created, remaining: kidsRemaining + created, target: targetKids };
}

/**
 * Génère 20 questions par catégorie (réparties 7 easy, 7 medium, 6 hard)
 */
export async function generateTwentyPerCategory(): Promise<number> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[AI] OPENAI_API_KEY non configurée, génération IA désactivée");
    return 0;
  }

  const cats = [...allowedCategories];
  let totalCreated = 0;

  for (const cat of cats) {
    const plan: Array<{ diff: 'easy'|'medium'|'hard'; count: number }> = [
      { diff: 'easy', count: 7 },
      { diff: 'medium', count: 7 },
      { diff: 'hard', count: 6 },
    ];

    for (const step of plan) {
      try {
        const qs = await generateQuestionsWithAI(step.diff, cat as any, step.count);
        for (const q of qs) {
          try {
            const duplicate = await isDuplicate(q.question);
            if (duplicate) continue;
            const shuffled = shuffleAnswers(q);
            await prisma.quizQuestion.create({
              data: {
                question: shuffled.question,
                optionA: shuffled.optionA,
                optionB: shuffled.optionB,
                optionC: shuffled.optionC,
                optionD: shuffled.optionD,
                correctAnswer: shuffled.correctAnswer,
                difficulty: shuffled.difficulty,
                category: shuffled.category,
                imageUrl: null,
              }
            });
            totalCreated++;
          } catch (e) {
            // mute unitaire
          }
        }
        // petite pause pour éviter rate limiting
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        // mute catégorie/diff
      }
    }
  }

  console.log(`[AI] Génération fixe: ${totalCreated} questions créées (20 par catégorie)`);
  await rotateQuestions();
  return totalCreated;
}

/**
 * Vérifie le stock restant et regénère si ≤ threshold
 */
export async function replenishIfLow(threshold = 100): Promise<{ remaining: number; created: number }> {
  // Calcule le "remaining" en excluant globalement les questions déjà posées
  const total = await prisma.quizQuestion.count();
  const used = await prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then(r => r.length);
  const remaining = Math.max(0, total - used);

  if (remaining <= threshold) {
    console.log(`[AI] Stock faible (remaining=${remaining} ≤ ${threshold}) → génération 20 par catégorie...`);
    const created = await generateTwentyPerCategory();
    return { remaining, created };
  }
  return { remaining, created: 0 };
}

/**
 * Génère un petit batch pour une catégorie/difficulté donnée et insère en base avec déduplication.
 */
async function generateAndSaveBatch(diff: 'easy'|'medium'|'hard', cat: typeof allowedCategories[number], count: number): Promise<number> {
  const qs = await generateQuestionsWithAI(diff, cat as any, count);
  let created = 0;
  for (const q of qs) {
    try {
      const duplicate = await isDuplicate(q.question);
      if (duplicate) continue;
      const shuffled = shuffleAnswers(q);
      await prisma.quizQuestion.create({
        data: {
          question: shuffled.question,
          optionA: shuffled.optionA,
          optionB: shuffled.optionB,
          optionC: shuffled.optionC,
          optionD: shuffled.optionD,
          correctAnswer: shuffled.correctAnswer,
          difficulty: shuffled.difficulty,
          category: shuffled.category,
          imageUrl: null,
        }
      });
      created++;
    } catch {}
  }
  return created;
}

/**
 * Maintient le stock de questions entre un minimum et une cible.
 * - Si remaining < min, génère par petits lots jusqu'à atteindre target (≈ 400)
 */
export async function maintainQuestionStock(min = 300, target = 400): Promise<{ remaining: number; created: number; target: number }> {
  // Calcule le stock restant (total - utilisées globalement)
  const total = await prisma.quizQuestion.count();
  const used = await prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then(r => r.length);
  const remaining = Math.max(0, total - used);

  if (!process.env.OPENAI_API_KEY) {
    console.warn("[AI] OPENAI_API_KEY manquante – maintien du stock désactivé");
    return { remaining, created: 0, target };
  }

  if (remaining >= min) {
    return { remaining, created: 0, target };
  }

  console.log(`[AI] Stock faible (remaining=${remaining} < ${min}) → génération par petits lots jusqu'à ${target}`);

  // 1) Assurer un stock minimum de questions enfants faciles (catégorie kids/enfants)
  const kidsCategories = ['kids','enfants'] as const;
  const kidsTotal = await prisma.quizQuestion.count({ where: { category: { in: kidsCategories as any } } });
  const kidsUsed = await prisma.quizAttempt.findMany({ where: { question: { category: { in: kidsCategories as any } } }, distinct: ["questionId"], select: { questionId: true } }).then(r => r.length);
  const kidsRemaining = Math.max(0, kidsTotal - kidsUsed);
  const minKids = 150;
  const targetKids = 200;
  let createdKids = 0;
  if (kidsRemaining < minKids) {
    const needKids = targetKids - kidsRemaining;
    const batchSize = Math.max(5, Math.min(20, needKids));
    const kidsBatch = await generateKidsQuestionsWithAI(batchSize);
    for (const q0 of kidsBatch) {
      try {
        const q = { ...q0, difficulty: 'easy' as const, category: 'kids' as const };
        if (await isDuplicate(q.question)) continue;
        const shuffled = shuffleAnswers(q);
        await prisma.quizQuestion.create({
          data: {
            question: shuffled.question,
            optionA: shuffled.optionA,
            optionB: shuffled.optionB,
            optionC: shuffled.optionC,
            optionD: shuffled.optionD,
            correctAnswer: shuffled.correctAnswer,
            difficulty: 'easy',
            category: 'kids',
            imageUrl: null,
          }
        });
        createdKids++;
      } catch {}
    }
    // petite pause
    await new Promise(r => setTimeout(r, 400));
  }
  let created = createdKids;
  const diffs: Array<'easy'|'medium'|'hard'> = ['easy','medium','hard'];

  // Boucle de petits batches (max ~50 itérations de sécurité)
  for (let i = 0; i < 50 && (remaining + created) < target; i++) {
    const needed = target - (remaining + created);
    const chunk = Math.min(15, Math.max(3, Math.floor(needed / 4))); // 3 à 15 questions par appel
    const cat = allowedCategories[Math.floor(Math.random() * allowedCategories.length)];
    // pondération simple: plus d'easy/medium
    const r = Math.random();
    const diff = r < 0.45 ? 'easy' : r < 0.8 ? 'medium' : 'hard';

    const c = await generateAndSaveBatch(diff, cat, chunk);
    created += c;
    // petite pause pour éviter le rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  await rotateQuestions();
  return { remaining, created, target };
}

/**
 * Rotation des questions : supprime les plus anciennes si trop nombreuses
 */
async function rotateQuestions() {
  // Pour maintenir une banque importante (≥1000) on relève fortement le plafond.
  // Ce plafond évite seulement une dérive infinie si des générations massives sont lancées.
  const MAX_PER_DIFFICULTY = 5000; // Permet jusqu'à 15 000 questions au total (3 niveaux)

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
