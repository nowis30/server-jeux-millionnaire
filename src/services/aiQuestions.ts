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
  // Ajout des catégories 'logic' et 'iq' pour questions de raisonnement / QI
  category: 'finance' | 'economy' | 'real-estate' | 'business' | 'technology' | 'science' | 'history' | 'geography' | 'sports' | 'arts' | 'cinema' | 'music' | 'literature' | 'culture' | 'nature' | 'health' | 'food' | 'general' | 'animals' | 'translation' | 'kids' | 'enfants' | 'quebec' | 'definitions' | 'religions' | 'logic' | 'iq' | 'anatomy';
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
- health: Santé, nutrition, bien-être, prévention
- anatomy: Anatomie et physiologie humaine (organes, systèmes, adaptations, vulnérabilités)
- food: Cuisine, recettes, gastronomie, ingrédients
- general: Culture générale variée, faits intéressants
- animals: Zoologie, espèces, habitats, comportements, chaînes alimentaires
- translation: Traduction FR/EN, faux amis, synonymes, expressions courantes
 - logic: Logique, suites de nombres, analogies, puzzles courts, déduction
 - iq: Problèmes de type QI: matrices conceptuelles simplifiées, séries, classification, relations
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
// Ouverture thématique adaptée :
- Culture québécoise très simple (poutine, hiver, drapeau du Québec, sirop d'érable)
- Fêtes et religions présentées factuellement et simplement (Noël, Hanoukka, Ramadan, Pâques)

Contraintes:
- Difficulté: "easy" uniquement
- Catégorie: "kids" (ou "enfants" acceptable) — même si le thème est Québec ou religions, reste dans cette catégorie
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
  'finance','economy','real-estate','business','technology','science','history','geography','sports','arts','cinema','music','literature','culture','nature','health','food','general','animals','translation','kids','enfants','quebec','definitions','religions','logic','iq','anatomy'
] as const;

const categoryPrompts = {
  finance: "Marché boursier, actions, obligations, dividendes, rendements, investissements",
  economy: "Économie, taux d'intérêt, inflation, PIB, commerce international",
  'real-estate': "Immobilier, hypothèques, propriétés, loyers, valorisation",
  business: "Entrepreneuriat, management, stratégie d'entreprise, marketing, leadership",
  technology: "Informatique, programmation, gadgets, IA, innovations technologiques",
  science: "Physique, chimie, biologie générale, astronomie, découvertes scientifiques",
  anatomy: "Anatomie et physiologie humaine: organes, systèmes (nerveux, musculaire, immunitaire), adaptations, forces (endurance, plasticité) et vulnérabilités (carences, blessures). Toujours factuel et neutre.",
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
  enfants: "Questions très faciles (6-9 ans): vocabulaire simple, monde concret, réponses évidentes",
  quebec: "Culture québécoise et canadienne-française: expressions, traditions, géographie locale (provinces/villes), sport (Canadiens de Montréal), histoire (Nouvelle-France), gastronomie (poutine, sirop d'érable)",
  definitions: "Définitions de mots en français (niveau intermédiaire): synonymes, antonymes, sens le plus juste, choix du bon terme dans un contexte",
  religions: "Religions du monde (faits neutres): principales croyances, lieux de culte, fêtes majeures, figures fondatrices, répartition géographique. Évite tout jugement ou controverse, reste factuel."
  ,logic: "Logique formelle et puzzles courts: suites de nombres, analogies, syllogismes simples, classification, relations (A est à B ce que C est à ?). Pas de calculs lourds."
  ,iq: "Questions de style QI: motifs conceptuels (sans images), complétion de séries, raisonnement abstrait, sélection de l'élément différent. Clarté et une seule réponse indiscutable."
};

// Quelques questions statiques de logique/QI si l'API OpenAI n'est pas disponible
const STATIC_LOGIC_QUESTIONS: GeneratedQuestion[] = [
  {
    question: "Quelle lettre complète la suite: A, C, F, J, O, ?",
    optionA: "S",
    optionB: "T",
    optionC: "U",
    optionD: "V",
    correctAnswer: 'B', // T (différences +2,+3,+4,+5 => +6)
    difficulty: 'medium',
    category: 'logic'
  },
  {
    question: "Trouver l'intrus: cube, sphère, cercle, pyramide",
    optionA: "cube",
    optionB: "sphère",
    optionC: "cercle",
    optionD: "pyramide",
    correctAnswer: 'C', // cercle (2D vs 3D)
    difficulty: 'easy',
    category: 'logic'
  },
  {
    question: "Suite numérique: 3, 6, 11, 18, 27, ?",
    optionA: "36",
    optionB: "38",
    optionC: "40",
    optionD: "42",
    correctAnswer: 'B', // +3,+5,+7,+9,+11 => 27+11 = 38 
    difficulty: 'easy',
    category: 'iq'
  },
  {
    question: "Si TORE est 1, ROTE est 2, TER0 est 3, quel est 4? (Permutation des lettres en gardant T,R,O,E)",
    optionA: "ETOR",
    optionB: "ERTO",
    optionC: "OTRE",
    optionD: "RETO",
    correctAnswer: 'A',
    difficulty: 'hard',
    category: 'iq'
  },
  {
    question: "Analogies: LUNE est à NUIT comme SOLEIL est à ?",
    optionA: "AUBE",
    optionB: "JOUR",
    optionC: "ÉTÉ",
    optionD: "CHALEUR",
    correctAnswer: 'B',
    difficulty: 'easy',
    category: 'logic'
  }
];

// Fallback statique anatomie si absence de clé OpenAI (quelques exemples neutres)
const STATIC_ANATOMY_QUESTIONS: GeneratedQuestion[] = [
  {
    question: "Quel organe est principalement responsable de la détoxification des substances chimiques dans le sang?",
    optionA: "Le foie",
    optionB: "Le rein",
    optionC: "La rate",
    optionD: "Le pancréas",
    correctAnswer: 'A',
    difficulty: 'easy',
    category: 'anatomy'
  },
  {
    question: "Quel type de muscle est involontaire et présent dans les parois intestinales?",
    optionA: "Strié squelettique",
    optionB: "Strié cardiaque",
    optionC: "Lisse",
    optionD: "Élastique",
    correctAnswer: 'C',
    difficulty: 'medium',
    category: 'anatomy'
  },
  {
    question: "Quelle est la principale faiblesse du système immunitaire inné par rapport à l'adaptatif?",
    optionA: "Réponse lente",
    optionB: "Absence de mémoire",
    optionC: "Dépendance aux anticorps",
    optionD: "Sensibilité aux vitamines",
    correctAnswer: 'B',
    difficulty: 'hard',
    category: 'anatomy'
  }
];

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
 * Normalisation avancée du texte: minuscules, suppression accents, ponctuation, chiffres, stop-words FR
 */
export function normalizeFr(text: string): string {
  const lower = (text || '').toLowerCase();
  const noAccents = lower.normalize('NFD').replace(/\p{Diacritic}+/gu, '');
  const noPunctNum = noAccents.replace(/[^a-z\s]/g, ' ');
  const tokens = noPunctNum.split(/\s+/).filter(Boolean);
  const STOP = new Set([
    'le','la','les','un','une','des','du','de','d','deux','trois','quatre','cinq','six','sept','huit','neuf','dix',
    'et','ou','est','sont','quel','quelle','quels','quelles','lequel','laquelle','lesquels','lesquelles','que','qui',
    'dans','sur','au','aux','a','à','pour','par','avec','sans','ce','cet','cette','ces','son','sa','ses','leur','leurs',
    'auquel','auxquels','auxquelles','duquel','desquels','desquelles','de','la','aupres','chez','comme','plus','moins',
    'quelque','quoi','dont','lors','entre','contre','vers','afin','car','donc','or','ni','mais','si','y','on','nous',
  ]);
  const filtered = tokens.filter(t => !STOP.has(t));
  return filtered.join(' ');
}

export function tokenize(text: string): string[] {
  return normalizeFr(text).split(/\s+/).filter(Boolean);
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = new Set([...a].filter(x => b.has(x)));
  const uni = new Set([...a, ...b]);
  return inter.size / uni.size;
}

export function charNgrams(text: string, n: number): Set<string> {
  const s = normalizeFr(text).replace(/\s+/g, ' ');
  const grams: string[] = [];
  for (let i = 0; i <= Math.max(0, s.length - n); i++) {
    grams.push(s.slice(i, i + n));
  }
  return new Set(grams);
}

export function levenshtein(a: string, b: string): number {
  const s = normalizeFr(a); const t = normalizeFr(b);
  const m = s.length; const n = t.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Vérifie si une question similaire existe déjà (éviter les doublons et paraphrases)
 */
async function isDuplicate(question: string): Promise<boolean> {
  const existing = await prisma.quizQuestion.findMany({ select: { question: true } });

  const tokensNew = new Set(tokenize(question));
  const gramsNew3 = charNgrams(question, 3);
  const lenNew = normalizeFr(question).length;

  for (const q of existing) {
    const qText = q.question || '';
    // Exact match (après normalisation simple)
    if (qText.trim().toLowerCase() === question.trim().toLowerCase()) return true;

    const tokensOld = new Set(tokenize(qText));
    const gramsOld3 = charNgrams(qText, 3);

    // 1) Similarité Jaccard sur tokens (après stop-words): seuil 0.8
    const jac = jaccard(tokensNew, tokensOld);
    if (jac >= 0.8) return true;

    // 2) Similarité caractères trigrammes: seuil 0.85
    const jac3 = jaccard(gramsNew3, gramsOld3);
    if (jac3 >= 0.85) return true;

    // 3) Levenshtein relatif (pour courtes questions re-formulées)
    const lenOld = normalizeFr(qText).length;
    const maxLen = Math.max(1, Math.max(lenNew, lenOld));
    if (maxLen <= 120) { // éviter coût sur très longs textes
      const lev = levenshtein(question, qText);
      const rel = lev / maxLen;
      if (rel <= 0.2) return true; // distance faible => proche
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
    // Fallback statique pour logique/QI si pas de clé
    if (category === 'logic' || category === 'iq') {
      console.warn("[AI] Pas de clé OpenAI – utilisation fallback statique logique/QI");
      return STATIC_LOGIC_QUESTIONS
        .filter(q => q.category === category)
        .slice(0, count)
        .map(q => ({ ...q }));
    }
    if (category === 'anatomy') {
      console.warn("[AI] Pas de clé OpenAI – utilisation fallback statique anatomie");
      return STATIC_ANATOMY_QUESTIONS
        .filter(q => q.category === 'anatomy')
        .slice(0, count)
        .map(q => ({ ...q }));
    }
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
      // Ajout logique/QI faciles pour diversifier les premières questions
      { difficulty: 'easy' as const, category: 'logic' as const, count: 4 },
      { difficulty: 'easy' as const, category: 'iq' as const, count: 3 },
      // Questions faciles (40 questions) - Culture générale accessible
      { difficulty: 'easy' as const, category: 'general' as const, count: 5 },
      { difficulty: 'easy' as const, category: 'geography' as const, count: 4 },
      { difficulty: 'easy' as const, category: 'history' as const, count: 4 },
      { difficulty: 'easy' as const, category: 'sports' as const, count: 4 },
      { difficulty: 'easy' as const, category: 'cinema' as const, count: 3 },
      { difficulty: 'easy' as const, category: 'music' as const, count: 3 },
  { difficulty: 'easy' as const, category: 'science' as const, count: 3 },
  { difficulty: 'easy' as const, category: 'anatomy' as const, count: 3 },
  { difficulty: 'easy' as const, category: 'nature' as const, count: 3 },
  { difficulty: 'easy' as const, category: 'animals' as const, count: 3 },
  { difficulty: 'easy' as const, category: 'translation' as const, count: 3 },
      { difficulty: 'easy' as const, category: 'food' as const, count: 3 },
      { difficulty: 'easy' as const, category: 'finance' as const, count: 2 },
      { difficulty: 'easy' as const, category: 'technology' as const, count: 2 },
      { difficulty: 'easy' as const, category: 'arts' as const, count: 2 },
      { difficulty: 'easy' as const, category: 'culture' as const, count: 2 },
      
      // Questions moyennes (35 questions) - Connaissances intermédiaires
      // Ajout de thèmes ciblés pour Q5-Q7: définitions de mots, culture québécoise et religions
      { difficulty: 'medium' as const, category: 'definitions' as const, count: 4 },
      { difficulty: 'medium' as const, category: 'quebec' as const, count: 4 },
      { difficulty: 'medium' as const, category: 'religions' as const, count: 4 },
  { difficulty: 'medium' as const, category: 'logic' as const, count: 4 },
  { difficulty: 'medium' as const, category: 'iq' as const, count: 3 },
      { difficulty: 'medium' as const, category: 'history' as const, count: 4 },
  { difficulty: 'medium' as const, category: 'science' as const, count: 4 },
  { difficulty: 'medium' as const, category: 'anatomy' as const, count: 3 },
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
      
      // Questions difficiles (accent IQ/Logique pour Q6–Q10)
  { difficulty: 'hard' as const, category: 'science' as const, count: 4 },
  { difficulty: 'hard' as const, category: 'anatomy' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'history' as const, count: 3 },
      { difficulty: 'hard' as const, category: 'literature' as const, count: 3 },
      { difficulty: 'hard' as const, category: 'technology' as const, count: 2 },
      { difficulty: 'hard' as const, category: 'arts' as const, count: 1 },
      { difficulty: 'hard' as const, category: 'finance' as const, count: 1 },
      { difficulty: 'hard' as const, category: 'real-estate' as const, count: 1 },
      { difficulty: 'hard' as const, category: 'business' as const, count: 1 },
      { difficulty: 'hard' as const, category: 'geography' as const, count: 1 },
      { difficulty: 'hard' as const, category: 'economy' as const, count: 1 },
      { difficulty: 'hard' as const, category: 'health' as const, count: 1 },
      { difficulty: 'hard' as const, category: 'logic' as const, count: 6 },
      { difficulty: 'hard' as const, category: 'iq' as const, count: 6 },
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
  const kidsUsed = await prisma.quizAttempt.findMany({ where: { question: { category: { in: kidsCategories as any }, difficulty: 'easy' } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length);
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
  const existingSet = new Set(existingKids.map((q: { question: string }) => q.question.toLowerCase().trim()));

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
 * Assure un stock minimum de questions MEDIUM pour les catégories ciblées (definitions, quebec)
 * Utilisé pour alimenter préférentiellement Q5-Q7.
 * Ne génère que des questions medium dans ces catégories, sans doublons.
 */
export async function ensureMediumPool(minMedium = 450, targetMedium = 500): Promise<{ created: number; remaining: number; target: number }> {
  const mediumCats = ['definitions','quebec','religions'] as const;
  // Compter total et utilisées (distinct attempts) pour ces catégories difficulté medium
  const mediumTotal = await prisma.quizQuestion.count({ where: { category: { in: mediumCats as any }, difficulty: 'medium' } });
  const mediumUsed = await prisma.quizAttempt.findMany({ where: { question: { category: { in: mediumCats as any }, difficulty: 'medium' } }, distinct: ['questionId'], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length);
  const mediumRemaining = Math.max(0, mediumTotal - mediumUsed);

  if (!process.env.OPENAI_API_KEY) {
    console.warn('[AI] OPENAI_API_KEY manquante – ensureMediumPool ne peut pas générer');
    return { created: 0, remaining: mediumRemaining, target: targetMedium };
  }

  if (mediumRemaining >= minMedium) {
    return { created: 0, remaining: mediumRemaining, target: targetMedium };
  }

  const toCreate = Math.max(0, targetMedium - mediumRemaining);
  let created = 0;
  const batchSize = 10;
  // Pré-charger pour déduplication rapide
  const existingMedium = await prisma.quizQuestion.findMany({ where: { category: { in: mediumCats as any }, difficulty: 'medium' }, select: { question: true } });
  const existingSet = new Set(existingMedium.map((q: { question: string }) => q.question.toLowerCase().trim()));

  // Boucles de génération alternant entre definitions et quebec
  for (let i = 0; i < Math.ceil(toCreate / batchSize); i++) {
    for (const cat of mediumCats) {
      if (created >= toCreate) break;
      try {
        const raw = await generateQuestionsWithAI('medium', cat as any, Math.min(batchSize, toCreate - created));
        for (const q0 of raw) {
          try {
            const key = q0.question.toLowerCase().trim();
            if (existingSet.has(key)) continue;
            if (q0.difficulty !== 'medium' || q0.category !== cat) continue;
            const isDup = await isDuplicate(q0.question);
            if (isDup) continue;
            const shuffled = shuffleAnswers({ ...q0, difficulty: 'medium', category: cat } as any);
            await prisma.quizQuestion.create({
              data: {
                question: shuffled.question,
                optionA: shuffled.optionA,
                optionB: shuffled.optionB,
                optionC: shuffled.optionC,
                optionD: shuffled.optionD,
                correctAnswer: shuffled.correctAnswer,
                difficulty: 'medium',
                category: cat,
                imageUrl: null,
              }
            });
            created++;
            existingSet.add(key);
          } catch {}
        }
        await new Promise(r => setTimeout(r, 400));
      } catch {}
    }
  }

  return { created, remaining: mediumRemaining + created, target: targetMedium };
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
  const used = await prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length);
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
  const used = await prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length);
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
  const kidsUsed = await prisma.quizAttempt.findMany({ where: { question: { category: { in: kidsCategories as any } } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length);
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
 * Assure un stock minimum de questions LOGIC / IQ (raisonnement abstrait).
 */
export async function ensureLogicPool(minLogic = 120, targetLogic = 160): Promise<{ created: number; remaining: number; target: number }> {
  const logicCats = ['logic','iq'] as const;
  const logicTotal = await prisma.quizQuestion.count({ where: { category: { in: logicCats as any } } });
  const logicUsed = await prisma.quizAttempt.findMany({ where: { question: { category: { in: logicCats as any } } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length);
  const logicRemaining = Math.max(0, logicTotal - logicUsed);

  if (logicRemaining >= minLogic) {
    return { created: 0, remaining: logicRemaining, target: targetLogic };
  }

  let created = 0;
  const toCreate = Math.max(0, targetLogic - logicRemaining);
  // Fallback si pas de clé: insérer questions statiques jusqu'à cible
  if (!process.env.OPENAI_API_KEY) {
    for (const base of STATIC_LOGIC_QUESTIONS) {
      if (created >= toCreate) break;
      if (await isDuplicate(base.question)) continue;
      const shuffled = shuffleAnswers(base);
      await prisma.quizQuestion.create({
        data: { question: shuffled.question, optionA: shuffled.optionA, optionB: shuffled.optionB, optionC: shuffled.optionC, optionD: shuffled.optionD, correctAnswer: shuffled.correctAnswer, difficulty: shuffled.difficulty, category: shuffled.category, imageUrl: null }
      });
      created++;
    }
    return { created, remaining: logicRemaining + created, target: targetLogic };
  }

  const batchSize = 8;
  for (let i = 0; i < Math.ceil(toCreate / batchSize); i++) {
    for (const cat of logicCats) {
      if (created >= toCreate) break;
      try {
        const raw = await generateQuestionsWithAI(i % 3 === 0 ? 'easy' : i % 3 === 1 ? 'medium' : 'hard', cat as any, Math.min(batchSize, toCreate - created));
        for (const q0 of raw) {
          try {
            if (await isDuplicate(q0.question)) continue;
            const shuffled = shuffleAnswers(q0);
            await prisma.quizQuestion.create({
              data: { question: shuffled.question, optionA: shuffled.optionA, optionB: shuffled.optionB, optionC: shuffled.optionC, optionD: shuffled.optionD, correctAnswer: shuffled.correctAnswer, difficulty: shuffled.difficulty, category: cat, imageUrl: null }
            });
            created++;
          } catch {}
        }
        await new Promise(r => setTimeout(r, 400));
      } catch {}
    }
  }
  return { created, remaining: logicRemaining + created, target: targetLogic };
}

/**
 * Assure un stock minimum de questions DIFFICILES (hard) pour IQ/LOGIC
 * Conçu pour alimenter les questions Q6–Q10 en priorité.
 */
// (Obsolète) Ancien maintien d'un pool dédié 'hard' logic/iq — conservé COMMENTÉ pour historique.
/*
export async function ensureHardLogicPool(minHard = 240, targetHard = 300): Promise<{ created: number; remaining: number; target: number }> {
  const logicCats = ['logic','iq'] as const;
  const hardTotal = await prisma.quizQuestion.count({ where: { difficulty: 'hard', category: { in: logicCats as any } } });
  const hardUsed = await prisma.quizAttempt.findMany({ where: { question: { difficulty: 'hard', category: { in: logicCats as any } } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length);
  const hardRemaining = Math.max(0, hardTotal - hardUsed);

  if (hardRemaining >= minHard) {
    return { created: 0, remaining: hardRemaining, target: targetHard };
  }

  const toCreate = Math.max(0, targetHard - hardRemaining);
  let created = 0;

  // Si pas de clé OpenAI, recycler des questions statiques en les marquant hard si possible
  if (!process.env.OPENAI_API_KEY) {
    for (const base of STATIC_LOGIC_QUESTIONS) {
      if (created >= toCreate) break;
      const q = { ...base, difficulty: 'hard' as const };
      if (await isDuplicate(q.question)) continue;
      const shuffled = shuffleAnswers(q as any);
      await prisma.quizQuestion.create({
        data: { question: shuffled.question, optionA: shuffled.optionA, optionB: shuffled.optionB, optionC: shuffled.optionC, optionD: shuffled.optionD, correctAnswer: shuffled.correctAnswer, difficulty: 'hard', category: q.category, imageUrl: null }
      });
      created++;
    }
    return { created, remaining: hardRemaining + created, target: targetHard };
  }

  const batchSize = 10;
  for (let i = 0; i < Math.ceil(toCreate / batchSize); i++) {
    for (const cat of logicCats) {
      if (created >= toCreate) break;
      try {
        const raw = await generateQuestionsWithAI('hard', cat as any, Math.min(batchSize, toCreate - created));
        for (const q0 of raw) {
          try {
            if (q0.difficulty !== 'hard') continue;
            if (await isDuplicate(q0.question)) continue;
            const shuffled = shuffleAnswers({ ...q0, difficulty: 'hard', category: cat } as any);
            await prisma.quizQuestion.create({
              data: { question: shuffled.question, optionA: shuffled.optionA, optionB: shuffled.optionB, optionC: shuffled.optionC, optionD: shuffled.optionD, correctAnswer: shuffled.correctAnswer, difficulty: 'hard', category: cat, imageUrl: null }
            });
            created++;
          } catch {}
        }
        await new Promise(r => setTimeout(r, 400));
      } catch {}
    }
  }

  return { created, remaining: hardRemaining + created, target: targetHard };
}
*/

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
  where: { id: { in: oldest.map((q: { id: string }) => q.id) } }
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

/**
 * Audit et nettoyage des doublons en base (similarité par Jaccard tokens + trigrammes)
 * - threshold: 0.0–1.0 (0.8 recommandé)
 * - dryRun: si true, ne supprime rien et renvoie uniquement les stats
 */
export async function auditAndCleanupDuplicates(threshold = 0.8, dryRun = true): Promise<{
  total: number;
  candidates: number;
  toDelete: number;
  deleted: number;
  threshold: number;
}> {
  const all = await prisma.quizQuestion.findMany({
    select: { id: true, question: true, createdAt: true, difficulty: true, category: true }
  });

  type Row = { id: string; question: string; createdAt: Date; difficulty: string; category: string; tokens: Set<string>; tri: Set<string> };
  const rows: Row[] = all.map((q: any) => ({
    id: q.id,
    question: q.question || '',
    createdAt: q.createdAt,
    difficulty: q.difficulty,
    category: q.category,
    tokens: new Set(tokenize(q.question || '')),
    tri: charNgrams(q.question || '', 3),
  }));

  // Grouper par difficulté pour réduire la complexité
  const byDiff = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byDiff.get(r.difficulty) || [];
    arr.push(r);
    byDiff.set(r.difficulty, arr);
  }

  const toDeleteIds = new Set<string>();
  let candidates = 0;

  function sim(a: Row, b: Row): number {
    const interTok = new Set([...a.tokens].filter(t => b.tokens.has(t))).size;
    const unionTok = new Set([...a.tokens, ...b.tokens]).size || 1;
    const jTok = interTok / unionTok;
    const interTri = new Set([...a.tri].filter(t => b.tri.has(t))).size;
    const unionTri = new Set([...a.tri, ...b.tri]).size || 1;
    const jTri = interTri / unionTri;
    return jTok * 0.6 + jTri * 0.4;
  }

  for (const [_diff, list] of byDiff.entries()) {
    // Tri par createdAt pour conserver la plus ancienne
    const l = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 0; i < l.length; i++) {
      const keep = l[i];
      if (toDeleteIds.has(keep.id)) continue;
      for (let j = i + 1; j < l.length; j++) {
        const cand = l[j];
        if (toDeleteIds.has(cand.id)) continue;
        const s = sim(keep, cand);
        if (s >= threshold) {
          candidates++;
          toDeleteIds.add(cand.id); // supprimer la plus récente
        }
      }
    }
  }

  let deleted = 0;
  if (!dryRun && toDeleteIds.size > 0) {
    const ids = Array.from(toDeleteIds);
    const BATCH = 200;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const res = await prisma.quizQuestion.deleteMany({ where: { id: { in: slice } } });
      deleted += (res as any)?.count ?? slice.length;
    }
  }

  return {
    total: rows.length,
    candidates,
    toDelete: toDeleteIds.size,
    deleted,
    threshold,
  };
}
