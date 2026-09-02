const DEFAULT_QUIZ_MODEL = "gpt-5.6-luna";
const MAX_EXISTING_CONTEXT = 80;
const MAX_GENERATED = 10;

const CATEGORY_SET = new Set([
  "finance","economy","real-estate","business","technology","science","history","geography","sports","arts",
  "cinema","music","literature","culture","nature","health","food","general","animals","translation","kids","enfants",
  "quebec","definitions","religions","logic","iq","anatomy",
]);

type Difficulty = "easy" | "medium" | "hard";
type Candidate = {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: "A" | "B" | "C" | "D";
  category: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractOutputText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.output_text === "string") return value.output_text;
  if (!Array.isArray(value.output)) return null;
  for (const output of value.output) {
    if (!isRecord(output) || !Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function clean(value: unknown, max = 280): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function validCandidate(value: unknown, difficulty: Difficulty, allowedCategories: string[]): Candidate | null {
  if (!isRecord(value)) return null;
  const question = clean(value.question, 260);
  const optionA = clean(value.optionA, 160);
  const optionB = clean(value.optionB, 160);
  const optionC = clean(value.optionC, 160);
  const optionD = clean(value.optionD, 160);
  const correctAnswer = clean(value.correctAnswer, 1) as Candidate["correctAnswer"];
  const category = clean(value.category, 40);
  if (question.length < 18 || !optionA || !optionB || !optionC || !optionD) return null;
  if (!(["A","B","C","D"] as string[]).includes(correctAnswer)) return null;
  if (!CATEGORY_SET.has(category) || !allowedCategories.includes(category)) return null;
  if (new Set([optionA, optionB, optionC, optionD].map((v) => v.toLocaleLowerCase("fr-CA"))).size !== 4) return null;
  // Le niveau est imposé par l'appelant; le modèle ne peut pas le modifier.
  void difficulty;
  return { question, optionA, optionB, optionC, optionD, correctAnswer, category };
}

async function callResponses(model: string, apiKey: string, instructions: string, input: string, schema: JsonRecord, maxOutputTokens: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22_000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: maxOutputTokens,
        instructions,
        input,
        text: { format: { type: "json_schema", name: "quiz_question_batch", strict: true, schema } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const payload: unknown = await response.json();
    const text = extractOutputText(payload);
    if (!text) throw new Error("Réponse IA vide");
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function generationSchema(categories: string[], count: number): JsonRecord {
  return {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question","optionA","optionB","optionC","optionD","correctAnswer","category"],
          properties: {
            question: { type: "string" },
            optionA: { type: "string" },
            optionB: { type: "string" },
            optionC: { type: "string" },
            optionD: { type: "string" },
            correctAnswer: { enum: ["A","B","C","D"] },
            category: { enum: categories },
          },
        },
      },
    },
  };
}

function reviewSchema(maxIndex: number): JsonRecord {
  return {
    type: "object",
    additionalProperties: false,
    required: ["approved"],
    properties: {
      approved: {
        type: "array",
        uniqueItems: true,
        maxItems: maxIndex,
        items: { type: "integer", minimum: 0, maximum: Math.max(0, maxIndex - 1) },
      },
    },
  };
}

/**
 * Génère un petit lot seulement quand le joueur a épuisé son stock inédit.
 * Deux passes IA : création puis validation factuelle/qualité.
 * Le trigger PostgreSQL `trg_guard_quiz_question_uniqueness` reste l'autorité finale
 * et refuse les doublons ou paraphrases trop proches.
 */
export async function generateVerifiedQuizBatch(
  db: any,
  difficulty: Difficulty,
  requestedCategories: string[],
  requestedCount = 8,
): Promise<number> {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
  if (!apiKey) return 0;
  const model = Deno.env.get("QUIZ_AI_MODEL")?.trim() || DEFAULT_QUIZ_MODEL;
  const categories = requestedCategories.filter((v) => CATEGORY_SET.has(v)).slice(0, 8);
  if (!categories.length) return 0;
  const count = Math.min(MAX_GENERATED, Math.max(3, Math.floor(requestedCount)));

  // Évite que plusieurs requêtes simultanées déclenchent des lots identiques.
  const recent = await db`
    select count(*)::integer as n
    from heritier.quiz_questions
    where active and source='ai-verified' and difficulty=${difficulty}
      and category = any(${categories}::text[])
      and created_at >= now() - interval '90 seconds'
  `;
  if (Number(recent[0]?.n ?? 0) > 0) return 0;

  const existing = await db`
    select category, question
    from heritier.quiz_questions
    where active and difficulty=${difficulty} and category = any(${categories}::text[])
    order by created_at desc
    limit ${MAX_EXISTING_CONTEXT}
  `;
  const forbidden = existing.map((row: any) => `[${row.category}] ${row.question}`).join("\n");

  const instructions = `Tu es la fabrique de questions du jeu Héritier Millionnaire. Tu produis des QCM en français canadien impeccable.\nRègles absolues :\n- Chaque question doit tester un CONCEPT réellement différent des autres et de la liste interdite. Une paraphrase est interdite.\n- Une seule des quatre réponses est correcte; les trois autres sont plausibles mais clairement fausses.\n- Les faits doivent être stables, vérifiables et non controversés. Évite l'actualité, les prix en temps réel, les opinions et les formulations ambiguës.\n- Ne crée aucune question médicale de diagnostic ou de traitement individuel.\n- Niveau demandé : ${difficulty}. easy = connaissance accessible; medium = compréhension/application; hard = raisonnement, calcul ou connaissance plus précise.\n- Ne reprends pas le même calcul avec d'autres nombres. Ne change pas seulement deux mots ou l'ordre des réponses.\n- Respecte exactement le schéma JSON.`;

  let generated: unknown;
  try {
    generated = await callResponses(
      model,
      apiKey,
      instructions,
      `Catégories autorisées: ${categories.join(", ")}\nNombre maximum: ${count}\n\nQuestions/concepts déjà présents — INTERDITS À REFORMULER:\n${forbidden || "aucun"}`,
      generationSchema(categories, count),
      5_000,
    );
  } catch (error) {
    console.warn("[quiz-ai] génération indisponible", error instanceof Error ? error.message : String(error));
    return 0;
  }

  const raw = isRecord(generated) && Array.isArray(generated.questions) ? generated.questions : [];
  const candidates = raw.flatMap((value) => {
    const candidate = validCandidate(value, difficulty, categories);
    return candidate ? [candidate] : [];
  });
  if (!candidates.length) return 0;

  // Deuxième passage : un relecteur indépendant élimine erreurs, ambiguïtés et ressemblances.
  let approvedIndices: number[] = [];
  try {
    const reviewed = await callResponses(
      model,
      apiKey,
      `Tu es le relecteur qualité d'une banque de QCM. Approuve seulement les indices dont la question est factuellement correcte, non ambiguë, avec exactement une bonne réponse, adaptée au niveau ${difficulty}, et réellement différente de toutes les autres candidates ainsi que des concepts interdits. En cas de doute, rejette.`,
      `Candidats:\n${JSON.stringify(candidates)}\n\nConcepts interdits:\n${forbidden || "aucun"}`,
      reviewSchema(candidates.length),
      1_200,
    );
    approvedIndices = isRecord(reviewed) && Array.isArray(reviewed.approved)
      ? reviewed.approved.filter((v): v is number => Number.isInteger(v) && v >= 0 && v < candidates.length)
      : [];
  } catch (error) {
    console.warn("[quiz-ai] vérification indisponible", error instanceof Error ? error.message : String(error));
    return 0;
  }

  let inserted = 0;
  for (const index of approvedIndices) {
    const q = candidates[index];
    try {
      await db`
        insert into heritier.quiz_questions(
          question, option_a, option_b, option_c, option_d, correct_answer,
          difficulty, category, image_url, active, bank_version, source, model, verified_at, quality_score
        ) values (
          ${q.question}, ${q.optionA}, ${q.optionB}, ${q.optionC}, ${q.optionD}, ${q.correctAnswer},
          ${difficulty}, ${q.category}, null, true, 'ai-live', 'ai-verified', ${model}, now(), 0.950
        )
      `;
      inserted += 1;
    } catch (error) {
      // Le garde-fou DB rejette notamment les questions trop similaires : c'est attendu.
      console.info("[quiz-ai] candidat rejeté par la banque", error instanceof Error ? error.message : String(error));
    }
  }
  return inserted;
}
