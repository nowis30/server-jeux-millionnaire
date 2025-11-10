import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { z } from "zod";
import { requireUserOrGuest, requireAdmin } from "./auth";
import { generateAndSaveQuestions, maintainQuestionStock, replenishIfLow, ensureKidsPool, ensureMediumPool, auditAndCleanupDuplicates } from "../services/aiQuestions";
import {
  updatePlayerTokens,
  consumeQuizToken,
  refundQuizToken,
  getTimeUntilNextToken,
  QUIZ_AD_REWARD,
} from "../services/quizTokens";

// Règle Quitte ou Double: démarrage à 50000$ et double à chaque bonne réponse
const BASE_STAKE = 50000;
const getPrizeAmount = (questionNumber: number) => BASE_STAKE * Math.pow(2, Math.max(0, questionNumber - 1));
const getDifficultyForQuestion = (questionNumber: number): 'easy' | 'medium' | 'hard' => {
  // Nouvelle répartition: 1-2 facile (enfants), 3-5 moyen (tous sujets), 6-10 difficile (tous sujets)
  if (questionNumber <= 2) return 'easy';
  if (questionNumber <= 5) return 'medium';
  return 'hard';
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const COOLDOWN_MINUTES = 60;
const MAX_QUESTIONS = 10;
const AD_RECHARGE_COOLDOWN_MINUTES = 30;

function computeAdCooldownSeconds(last: Date | string | null | undefined): number {
  if (!last) return 0;
  const lastDate = typeof last === 'string' ? new Date(last) : last;
  const elapsedMs = Date.now() - lastDate.getTime();
  const windowMs = AD_RECHARGE_COOLDOWN_MINUTES * 60 * 1000;
  if (elapsedMs >= windowMs) return 0;
  return Math.max(0, Math.ceil((windowMs - elapsedMs) / 1000));
}

// Images enfant pour les 2 premières questions (thèmes simples, pédagogiques)
// Ancienne configuration d'images enfants désactivée
const CHILD_FRIENDLY_IMAGES: Record<number, string> = {};

// Désactivation des images enfants personnalisées: ne retourne plus d'image spécifique
function attachImage(_questionNumber: number, q: any) {
  if (!q) return q;
  return { ...q, imageUrl: null };
}

// Récupérer les catégories déjà utilisées dans la session courante
async function getUsedCategoriesForSession(sessionId: string): Promise<Set<string>> {
  const attempts = await prisma.quizAttempt.findMany({
    where: { sessionId },
    include: { question: { select: { category: true } } },
  });
  const used = new Set<string>();
  for (const a of attempts) {
    if (a.question?.category) used.add(a.question.category);
  }
  return used;
}

// Sélection d'une question non vue par difficulté en mélangeant les sujets
// Calcule une signature normalisée pour comparer la similarité rapide (Jaccard tokens + trigrammes)
function quickSignature(text: string) {
  const base = text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}+/gu,'').replace(/[^a-z\s]/g,' ').split(/\s+/).filter(Boolean).filter(t=>!['le','la','les','un','une','des','du','de','et','ou','est','sont','que','qui','dans','sur','au','aux','pour','par','avec','sans','ce','cet','cette','ces','son','sa','ses','leur','leurs','plus','moins','on','nous','vous','ils','elles'].includes(t));
  const tokens = new Set(base);
  const tri = new Set<string>();
  const joined = base.join(' ');
  for (let i=0;i<=Math.max(0, joined.length-3);i++) tri.add(joined.slice(i,i+3));
  return { tokens, tri };
}

function similarity(sigA: ReturnType<typeof quickSignature>, sigB: ReturnType<typeof quickSignature>): number {
  const interTok = new Set([...sigA.tokens].filter(x=>sigB.tokens.has(x))).size;
  const unionTok = new Set([...sigA.tokens, ...sigB.tokens]).size || 1;
  const jTok = interTok/unionTok;
  const interTri = new Set([...sigA.tri].filter(x=>sigB.tri.has(x))).size;
  const unionTri = new Set([...sigA.tri, ...sigB.tri]).size || 1;
  const jTri = interTri/unionTri;
  return (jTok*0.6 + jTri*0.4);
}

// Seuil de similarité maximal autorisé entre une nouvelle question et les récentes
const SIMILARITY_THRESHOLD = 0.65;

// Maintient un cache des dernières questions posées dans la session pour éviter paraphrases
async function getRecentSessionQuestions(sessionId: string, limit = 5): Promise<Array<{ id: string; question: string }>> {
  const attempts = await prisma.quizAttempt.findMany({
    where: { sessionId },
    include: { question: { select: { id: true, question: true } } },
    orderBy: { answeredAt: 'desc' },
    take: limit,
  });
  return attempts.map((a: { question: { id: string; question: string } }) => ({ id: a.question.id, question: a.question.question }));
}
async function selectUnseenQuestion(playerId: string, difficulty: string, sessionId?: string): Promise<any> {
  // Compter toutes les questions pour cette difficulté (toutes catégories confondues)
  const totalCountAll = await prisma.quizQuestion.count({ where: { difficulty } });
  if (totalCountAll === 0) return null;

  // Toutes les questions déjà vues (pour cette difficulté)
  const seenInDifficulty = await prisma.quizQuestionSeen.findMany({
    where: { playerId, question: { difficulty } },
    select: { questionId: true },
  });
  const seenIdsAll = seenInDifficulty.map((s: { questionId: string }) => s.questionId);
  const seenCountAll = seenIdsAll.length;

  // Questions déjà posées globalement (utilisées dans au moins une tentative)
  const globallyUsed = await prisma.quizAttempt.findMany({
    where: { question: { difficulty } },
    distinct: ["questionId"],
    select: { questionId: true },
  });
  const usedIdsAll = new Set(globallyUsed.map((g: { questionId: string }) => g.questionId));

  // Si tout a été vu pour cette difficulté, on réinitialise et on prend au hasard
  if (seenCountAll >= totalCountAll) {
    await prisma.quizQuestionSeen.deleteMany({ where: { playerId, question: { difficulty } } });
    const skip = Math.floor(Math.random() * totalCountAll);
    // Éviter de sélectionner une question déjà posée globalement
    const q = await prisma.quizQuestion.findFirst({ where: { difficulty, id: { notIn: Array.from(usedIdsAll) } }, skip });
    if (q) return q;
    // Si tout est utilisé globalement, on ne peut plus en fournir
    return null;
  }

  // Récupérer dynamiquement les catégories disponibles pour cette difficulté
  const distinctCats = await prisma.quizQuestion.findMany({
    where: { difficulty },
    distinct: ["category"],
    select: { category: true },
  });
  let categoriesAll = distinctCats.map((c: { category: string }) => c.category).filter(Boolean) as string[];
  // Ordre des catégories: celles pas encore vues dans la session d'abord
  let categoriesOrder: string[] = categoriesAll;
  if (sessionId) {
    const usedInSession = await getUsedCategoriesForSession(sessionId);
    const notUsed = categoriesAll.filter((c) => !usedInSession.has(c));
    const alreadyUsed = categoriesAll.filter((c) => usedInSession.has(c));
    categoriesOrder = [...shuffle(notUsed), ...shuffle(alreadyUsed)];
  } else {
    categoriesOrder = shuffle(categoriesOrder);
  }

  // Préparer signatures des récentes questions pour filtrage sémantique
  const recent = sessionId ? await getRecentSessionQuestions(sessionId, 7) : [];
  const recentSigs = recent.map(r => ({ id: r.id, sig: quickSignature(r.question) }));

  // Essayer de choisir une question non vue par catégorie dans l'ordre calculé
  for (const category of categoriesOrder) {
    const totalCountCat = await prisma.quizQuestion.count({ where: { difficulty, category } });
    if (totalCountCat === 0) continue;

    const seenInCat = await prisma.quizQuestionSeen.findMany({
      where: { playerId, question: { difficulty, category } },
      select: { questionId: true },
    });
  const seenIdsCat = seenInCat.map((s: { questionId: string }) => s.questionId);
    const excludedIdsCat = new Set([...seenIdsCat, ...Array.from(usedIdsAll)]);
    const unseenCountCat = totalCountCat - seenIdsCat.length;
    if (unseenCountCat <= 0) continue;

    const skip = Math.floor(Math.random() * unseenCountCat);
    let attempt = await prisma.quizQuestion.findFirst({
      where: { difficulty, category, id: { notIn: Array.from(excludedIdsCat) } },
      skip,
    });
    if (attempt) {
      const sigAttempt = quickSignature(attempt.question);
  // Refuser si trop similaire (>= seuil) à une des récentes
  const tooClose = recentSigs.some(r => similarity(sigAttempt, r.sig) >= SIMILARITY_THRESHOLD);
      if (tooClose) {
        // Chercher une autre dans la même catégorie (scan linéaire limité)
        const alt = await prisma.quizQuestion.findMany({
          where: { difficulty, category, id: { notIn: Array.from(excludedIdsCat) } },
          take: 10,
        });
          const picked = alt.find((a: { question: string }) => !recentSigs.some(r => similarity(sigAttempt, quickSignature(a.question)) >= SIMILARITY_THRESHOLD));
        if (picked) attempt = picked;
      }
      if (attempt) return attempt;
    }
  }

  // Fallback: choisir n'importe quelle question non vue pour la difficulté (toutes catégories)
  const excludedAll = Array.from(new Set([...seenIdsAll, ...Array.from(usedIdsAll)]));
  const unseenCountAll = totalCountAll - excludedAll.length;
  if (unseenCountAll > 0) {
    const skip = Math.floor(Math.random() * unseenCountAll);
    const candidate = await prisma.quizQuestion.findFirst({ where: { difficulty, id: { notIn: excludedAll } }, skip });
    if (candidate) {
      const sigCand = quickSignature(candidate.question);
  if (!recentSigs.some(r => similarity(sigCand, r.sig) >= SIMILARITY_THRESHOLD)) return candidate;
      // Fallback: chercher autre
      const others = await prisma.quizQuestion.findMany({ where: { difficulty, id: { notIn: excludedAll } }, take: 15 });
  const alt = others.find((o: { question: string }) => !recentSigs.some(r => similarity(quickSignature(o.question), r.sig) >= SIMILARITY_THRESHOLD));
      if (alt) return alt;
    }
  }

  // Dernier recours (ne devrait pas arriver car on a géré la réinitialisation): aléatoire dans la difficulté
  return null;
}

// Sélection dédiée pour premières questions enfant (Q1-Q2)
async function selectKidFriendlyQuestion(playerId: string, sessionId?: string): Promise<any> {
  const difficulty = 'easy';
  const preferredCats = ['kids', 'enfants', 'enfant'];

  // Préférer les catégories enfant si disponibles et non vues
  for (const cat of preferredCats) {
    const totalCat = await prisma.quizQuestion.count({ where: { difficulty, category: cat } });
    if (totalCat === 0) continue;
    const seenCat = await prisma.quizQuestionSeen.findMany({ where: { playerId, question: { difficulty, category: cat } }, select: { questionId: true } });
  const seenIds = seenCat.map((s: { questionId: string }) => s.questionId);
    const remaining = totalCat - seenIds.length;
    if (remaining <= 0) continue;
    const skip = Math.floor(Math.random() * remaining);
    const q = await prisma.quizQuestion.findFirst({ where: { difficulty, category: cat, id: { notIn: seenIds } }, skip });
    if (q) return q;
  }

  // Fallback heuristique: choisir une question facile courte
  const totalEasy = await prisma.quizQuestion.count({ where: { difficulty } });
  if (totalEasy === 0) return null;
  const seenAll = await prisma.quizQuestionSeen.findMany({ where: { playerId, question: { difficulty } }, select: { questionId: true } });
  const seenIdsAll = new Set(seenAll.map((s: { questionId: string }) => s.questionId));
  const unseenCount = totalEasy - seenAll.length;
  if (unseenCount <= 0) {
    return await selectUnseenQuestion(playerId, difficulty, sessionId);
  }
  const batchSize = Math.min(20, unseenCount);
  const batchSkip = Math.max(0, Math.floor(Math.random() * Math.max(1, unseenCount - batchSize)));
  const candidates = await prisma.quizQuestion.findMany({ where: { difficulty, id: { notIn: Array.from(seenIdsAll) } }, take: batchSize, skip: batchSkip });
  if (candidates.length === 0) return await selectUnseenQuestion(playerId, difficulty, sessionId);
  const scored = candidates.map((c: { question: string; optionA?: string; optionB?: string; optionC?: string; optionD?: string }) => {
    const lenQ = (c.question || '').length;
    const maxOpt = Math.max((c.optionA||'').length, (c.optionB||'').length, (c.optionC||'').length, (c.optionD||'').length);
    const score = lenQ + maxOpt * 2; // plus petit = plus simple
    return { c, score };
  }).sort((a: { c: any; score: number }, b: { c: any; score: number }) => a.score - b.score);
  return scored[0]?.c || candidates[0];
}

// Sélection difficile générique (Q6–Q10) sur toutes catégories hard
async function selectHardGeneric(playerId: string, sessionId?: string): Promise<any> {
  return await selectUnseenQuestion(playerId, 'hard', sessionId);
}

// Fonction pour marquer une question comme vue
async function markQuestionAsSeen(playerId: string, questionId: string): Promise<void> {
  await prisma.quizQuestionSeen.upsert({
    where: {
      playerId_questionId: { playerId, questionId },
    },
    create: {
      playerId,
      questionId,
    },
    update: {
      seenAt: new Date(),
    },
  });
}

export async function registerQuizRoutes(app: FastifyInstance) {
  
  // GET /api/games/:gameId/quiz/status - Vérifier si le joueur peut jouer
  app.get("/api/games/:gameId/quiz/status", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const user = (req as any).user;

    try {
      // Essayer de trouver le joueur via différentes méthodes (priorité : header > middleware > cookie)
      const playerIdHeader = req.headers['x-player-id'] as string | undefined;
      const playerIdFromMiddleware = user.playerIdFromHeader as string | undefined;
      
      let player;
      
      // Priorité 1: Header X-Player-ID direct
      if (playerIdHeader) {
        player = await prisma.player.findFirst({
          where: { id: playerIdHeader, gameId },
        });
      }
      // Priorité 2: Header passé par le middleware
      else if (playerIdFromMiddleware) {
        player = await prisma.player.findFirst({
          where: { id: playerIdFromMiddleware, gameId },
        });
      }
      // Priorité 3: Cookie guest (Android/Chrome)
      else if (user.guestId) {
        player = await prisma.player.findFirst({
          where: { gameId, guestId: user.guestId },
        });
      }

      if (!player) {
        return reply.status(404).send({ error: "Joueur non trouvé" });
      }

      // Mettre à jour les tokens du joueur (ajoute les tokens gagnés depuis la dernière vérification)
      const currentTokens = await updatePlayerTokens(player.id);
      const secondsUntilNextToken = await getTimeUntilNextToken(player.id);

      // Vérifier s'il y a une session active
      const activeSession = await prisma.quizSession.findFirst({
        where: {
          playerId: player.id,
          gameId,
          status: 'active',
        },
        include: {
          attempts: {
            orderBy: { questionNumber: 'desc' },
            take: 1,
          },
        },
      });

  const adCooldownSeconds = computeAdCooldownSeconds((player as any)?.lastAdQuizAt);

      if (activeSession) {
        const currentPrizeAmount = getPrizeAmount(activeSession.currentQuestion);
        return reply.send({
          canPlay: true,
          hasActiveSession: true,
          tokens: currentTokens,
          secondsUntilNextToken,
          adCooldownSeconds,
          adReward: QUIZ_AD_REWARD,
          session: {
            id: activeSession.id,
            currentQuestion: activeSession.currentQuestion,
            currentEarnings: activeSession.currentEarnings,
            securedAmount: 0,
            skipsLeft: (activeSession as any).skipsLeft ?? 0,
            nextPrize: currentPrizeAmount,
          },
        });
      }

      // Pas de session active, retourner le statut des tokens
      return reply.send({
        canPlay: currentTokens > 0,
        hasActiveSession: false,
        tokens: currentTokens,
        secondsUntilNextToken,
        adCooldownSeconds,
        adReward: QUIZ_AD_REWARD,
      });

    } catch (err: any) {
      app.log.error({ err }, "Erreur status quiz");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/quiz/ensure-kids - Remplir/assurer le stock de questions enfants (secret requis)
  app.get("/api/quiz/ensure-kids", async (req, reply) => {
    try {
      const querySchema = z.object({
        secret: z.string().optional(),
        min: z.coerce.number().optional(),
        target: z.coerce.number().optional(),
      });
      const { secret, min = 450, target = 500 } = querySchema.parse((req as any).query || {});

      const expectedSecret = process.env.QUIZ_GENERATION_SECRET || "generate123";
      if (secret !== expectedSecret) {
        return reply.status(401).send({ error: "Secret invalide - ajoutez ?secret=generate123" });
      }

      const res = await ensureKidsPool(min, target);
      return reply.send({ success: true, ...res });
    } catch (err: any) {
      app.log.error({ err }, "Erreur ensure-kids");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/quiz/ensure-medium - Remplir/assurer le stock de questions medium ciblées (definitions, quebec) (secret requis)
  app.get("/api/quiz/ensure-medium", async (req, reply) => {
    try {
      const querySchema = z.object({
        secret: z.string().optional(),
        min: z.coerce.number().optional(),
        target: z.coerce.number().optional(),
      });
      const { secret, min = 450, target = 500 } = querySchema.parse((req as any).query || {});
      const expectedSecret = process.env.QUIZ_GENERATION_SECRET || "generate123";
      if (secret !== expectedSecret) {
        return reply.status(401).send({ error: "Secret invalide - ajoutez ?secret=generate123" });
      }
      const res = await ensureMediumPool(min, target);
      return reply.send({ success: true, ...res });
    } catch (err: any) {
      app.log.error({ err }, "Erreur ensure-medium");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/games/:gameId/quiz/skip - Passer la question actuelle (max 3 fois)
  app.post("/api/games/:gameId/quiz/skip", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({ sessionId: z.string(), questionId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
  const { sessionId, questionId } = bodySchema.parse((req as any).body);

    try {
      const session = await prisma.quizSession.findUnique({ where: { id: sessionId }, include: { player: true } });
      if (!session || session.status !== 'active') {
        return reply.status(404).send({ error: "Session non trouvée ou terminée" });
      }
      if (session.gameId !== gameId) {
        return reply.status(403).send({ error: "Cette session n'appartient pas à cette partie" });
      }

      const currentSkips = (session as any).skipsLeft ?? 0;
      if (currentSkips <= 0) {
        return reply.status(400).send({ error: "Plus de saut disponible" });
      }

      // Sélectionner une nouvelle question de même difficulté (enfant si Q<=2)
      const diff = getDifficultyForQuestion(session.currentQuestion);
      const nextQuestion = session.currentQuestion <= 2
        ? await selectKidFriendlyQuestion(session.playerId, session.id)
        : (diff === 'medium'
            ? await selectUnseenQuestion(session.playerId, diff, session.id)
      : await selectHardGeneric(session.playerId, session.id));
      if (!nextQuestion) {
        return reply.status(500).send({ error: "Aucune autre question disponible" });
      }

      // Décrémenter skipsLeft (colonne ajoutée). Si la colonne n'existe pas encore (migration non appliquée), retourner une erreur explicite.
      try {
        await prisma.quizSession.update({ where: { id: session.id }, data: { /* @ts-ignore */ skipsLeft: (currentSkips - 1) as any } as any });
      } catch (e: any) {
        return reply.status(501).send({ error: "La fonction 'Passer la question' n'est pas encore disponible (mise à jour base de données requise)." });
      }

      // Récupérer la question actuelle pour exposer la bonne réponse et la retirer pour ce joueur
      const currentQ = await prisma.quizQuestion.findUnique({ where: { id: questionId } });
      if (!currentQ) {
        return reply.status(404).send({ error: "Question courante introuvable" });
      }

      // Marquer la question SKIPPÉE comme vue pour ce joueur (elle ne reviendra pas pour lui)
      await markQuestionAsSeen(session.playerId, currentQ.id);

      // Enregistrer un 'attempt' spécial pour signaler une consommation globale (évite les doublons pour tous)
      try {
        await prisma.quizAttempt.create({
          data: {
            sessionId: session.id,
            questionId: currentQ.id,
            questionNumber: session.currentQuestion,
            playerAnswer: 'SKIP' as any,
            isCorrect: false,
            prizeBefore: session.currentEarnings,
            prizeAfter: session.currentEarnings,
          },
        });
      } catch {}

      // Marquer la NOUVELLE question comme vue
      await markQuestionAsSeen(session.playerId, nextQuestion.id);

      return reply.send({
        skipped: true,
        correctAnswer: currentQ.correctAnswer,
        session: {
          id: session.id,
          currentQuestion: session.currentQuestion,
          currentEarnings: session.currentEarnings,
          securedAmount: 0,
          skipsLeft: Math.max(0, currentSkips - 1),
          nextPrize: getPrizeAmount(session.currentQuestion),
        },
        question: (() => {
          const qWithImg = attachImage(session.currentQuestion, nextQuestion);
          return {
            id: qWithImg.id,
            text: qWithImg.question,
            optionA: qWithImg.optionA,
            optionB: qWithImg.optionB,
            optionC: qWithImg.optionC,
            optionD: qWithImg.optionD,
            imageUrl: null,
          };
        })(),
      });

    } catch (err: any) {
      app.log.error({ err }, "Erreur skip quiz");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/games/:gameId/quiz/ad-skip - Recharge publicitaire d'un saut (skip) sans perdre la progression
  app.post("/api/games/:gameId/quiz/ad-skip", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({ sessionId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const { sessionId } = bodySchema.parse((req as any).body);
    try {
  const session = await (prisma as any).quizSession.findUnique({ where: { id: sessionId }, select: { id: true, gameId: true, status: true, skipsLeft: true, lastAdSkipAt: true } });
      if (!session || session.status !== 'active') {
        return reply.status(404).send({ error: 'Session non trouvée ou non active' });
      }
      if (session.gameId !== gameId) {
        return reply.status(403).send({ error: 'Session hors de cette partie' });
      }
      const MAX_SKIPS = 3;
      const COOLDOWN_MINUTES = 20; // Une recharge toutes les 20 minutes
      if (session.lastAdSkipAt) {
        const diffMin = (Date.now() - new Date(session.lastAdSkipAt).getTime()) / 60000;
        if (diffMin < COOLDOWN_MINUTES) {
          const remain = Math.ceil(COOLDOWN_MINUTES - diffMin);
          return reply.status(429).send({ error: `Recharge skip trop fréquente. Réessayez dans ${remain} min.` });
        }
      }
      // Si le joueur a déjà des skips >0 on peut soit refuser, soit plafonner; ici on autorise uniquement si < MAX_SKIPS
      if ((session as any).skipsLeft >= MAX_SKIPS) {
        return reply.status(400).send({ error: 'Nombre de sauts déjà au maximum.' });
      }
      const newSkips = Math.min(MAX_SKIPS, (session as any).skipsLeft + 1);
      await (prisma as any).quizSession.update({
        where: { id: session.id },
        data: {
          skipsLeft: newSkips,
          adSkipRechargeCount: { increment: 1 } as any,
          lastAdSkipAt: new Date(),
        },
      });
      return reply.send({ ok: true, sessionId: session.id, skipsLeft: newSkips, message: 'Un saut a été rechargé via annonce.' });
    } catch (err: any) {
      app.log.error({ err }, 'Erreur ad-skip');
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/games/:gameId/quiz/timeout - Temps écoulé: si skip dispo -> auto-skip; sinon cash-out des gains
  app.post("/api/games/:gameId/quiz/timeout", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({ sessionId: z.string(), questionId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const { sessionId, questionId } = bodySchema.parse((req as any).body);

    try {
      const session = await prisma.quizSession.findUnique({ where: { id: sessionId }, include: { player: true } });
      if (!session || session.status !== 'active') {
        return reply.status(404).send({ error: "Session non trouvée ou terminée" });
      }
      if (session.gameId !== gameId) {
        return reply.status(403).send({ error: "Cette session n'appartient pas à cette partie" });
      }

      const question = await prisma.quizQuestion.findUnique({ where: { id: questionId } });
      if (!question) {
        return reply.status(404).send({ error: "Question non trouvée" });
      }

      const currentSkips = (session as any).skipsLeft ?? 0;
      const prizeBefore = session.currentEarnings;

      if (currentSkips > 0) {
        // AUTO-SKIP: décrémenter le skip, marquer la question, et fournir une nouvelle question même difficulté
        // Sélectionner la prochaine question (même logique que /skip)
        const diff = getDifficultyForQuestion(session.currentQuestion);
        const nextQuestion = session.currentQuestion <= 2
          ? await selectKidFriendlyQuestion(session.playerId, session.id)
          : (diff === 'medium'
              ? await selectUnseenQuestion(session.playerId, diff, session.id)
              : await selectHardGeneric(session.playerId, session.id));
        if (!nextQuestion) {
          return reply.status(500).send({ error: "Aucune autre question disponible" });
        }

        try {
          await prisma.quizSession.update({ where: { id: session.id }, data: { /* @ts-ignore */ skipsLeft: (currentSkips - 1) as any } as any });
        } catch (e: any) {
          return reply.status(501).send({ error: "La fonction 'Passer la question' n'est pas encore disponible (mise à jour base de données requise)." });
        }

        // Marquer la question écoulée comme vue
        await markQuestionAsSeen(session.playerId, question.id);

        // Enregistrer une tentative TIMEOUT_SKIP (ne change pas les gains)
        try {
          await prisma.quizAttempt.create({
            data: {
              sessionId: session.id,
              questionId: question.id,
              questionNumber: session.currentQuestion,
              playerAnswer: 'TIMEOUT_SKIP' as any,
              isCorrect: false,
              prizeBefore,
              prizeAfter: prizeBefore,
            },
          });
        } catch {}

        // Marquer la nouvelle question comme vue
        await markQuestionAsSeen(session.playerId, nextQuestion.id);

        return reply.send({
          timeout: true,
          action: 'auto-skip',
          correctAnswer: question.correctAnswer,
          session: {
            id: session.id,
            currentQuestion: session.currentQuestion,
            currentEarnings: session.currentEarnings,
            securedAmount: (session as any).securedAmount ?? 0,
            skipsLeft: Math.max(0, currentSkips - 1),
            nextPrize: getPrizeAmount(session.currentQuestion),
          },
          question: (() => {
            const qWithImg = attachImage(session.currentQuestion, nextQuestion);
            return {
              id: qWithImg.id,
              text: qWithImg.question,
              optionA: qWithImg.optionA,
              optionB: qWithImg.optionB,
              optionC: qWithImg.optionC,
              optionD: qWithImg.optionD,
              imageUrl: null,
            };
          })(),
        });
      }

      // Pas de skip restant: CASH-OUT automatique des gains courants
      const prizeAfter = prizeBefore; // on encaisse ce qui est déjà gagné

      // Enregistrer la tentative TIMEOUT_CASHOUT (ne change pas la valeur)
      try {
        await prisma.quizAttempt.create({
          data: {
            sessionId: session.id,
            questionId: question.id,
            questionNumber: session.currentQuestion,
            playerAnswer: 'TIMEOUT_CASHOUT' as any,
            isCorrect: null as any,
            prizeBefore,
            prizeAfter,
          },
        });
      } catch {}

      // Marquer la session comme encaissée
      await prisma.quizSession.update({
        where: { id: session.id },
        data: { status: 'cashed-out', completedAt: new Date() },
      });

      // Créditer le joueur
      if (prizeAfter > 0) {
        await prisma.player.update({
          where: { id: session.playerId },
          data: {
            cash: { increment: prizeAfter },
            netWorth: { increment: prizeAfter },
            cumulativeQuizGain: { increment: prizeAfter },
          },
        });
      }

      return reply.send({
        timeout: true,
        action: 'auto-cash-out',
        correctAnswer: question.correctAnswer,
        finalPrize: prizeAfter,
        message: `Temps écoulé ! Vous avez encaissé $${prizeAfter.toLocaleString()} !`,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur timeout quiz");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/games/:gameId/quiz/start - Démarrer une nouvelle session
  app.post("/api/games/:gameId/quiz/start", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const user = (req as any).user;

    try {
      // Support iOS : utiliser X-Player-ID header si disponible (priorités multiples)
      const playerIdHeader = req.headers['x-player-id'] as string | undefined;
      const playerIdFromMiddleware = user.playerIdFromHeader as string | undefined;
      
      let player;
      
      if (playerIdHeader) {
        player = await prisma.player.findFirst({
          where: { id: playerIdHeader, gameId },
        });
      } else if (playerIdFromMiddleware) {
        player = await prisma.player.findFirst({
          where: { id: playerIdFromMiddleware, gameId },
        });
      } else if (user.guestId) {
        player = await prisma.player.findFirst({
          where: { gameId, guestId: user.guestId },
        });
      }

      if (!player) {
        return reply.status(404).send({ error: "Joueur non trouvé" });
      }

      // Mettre à jour les tokens avant de vérifier
      await updatePlayerTokens(player.id);

      // Vérifier qu'il n'y a pas de session active
      const existingActive = await prisma.quizSession.findFirst({
        where: { playerId: player.id, gameId, status: 'active' },
      });

      if (existingActive) {
        return reply.status(400).send({ error: "Vous avez déjà une session en cours" });
      }

      // Consommer un token
      const tokenConsumed = await consumeQuizToken(player.id);
      
      if (!tokenConsumed) {
        return reply.status(403).send({ error: "Pas assez de tokens. Attendez pour en gagner un nouveau." });
      }

      // Créer une nouvelle session
      let session;
      try {
        session = await prisma.quizSession.create({
          data: {
            playerId: player.id,
            gameId,
            status: 'active',
            currentQuestion: 1,
            currentEarnings: 0,
            securedAmount: 0,
          },
        });
      } catch (err: any) {
        // Si la création échoue, rembourser le token
        await refundQuizToken(player.id);
        throw err;
      }

  // Précharger pools nécessaires (kids pour Q1-2, medium générique pour Q3-5, hard IQ/logic pour 6-10 via génération standard)
  try { ensureKidsPool(450, 500).catch(() => {}); } catch {}
  const question = await selectKidFriendlyQuestion(player.id, session.id);

      if (!question) {
        // Rembourser le token si aucune question disponible
        await refundQuizToken(player.id);
        return reply.status(500).send({ error: "Aucune question disponible" });
      }

      // Marquer la question comme vue
      await markQuestionAsSeen(player.id, question.id);

      return reply.send({
        sessionId: session.id,
        currentQuestion: 1,
        currentEarnings: 0,
        securedAmount: 0,
        skipsLeft: 3,
        nextPrize: getPrizeAmount(1),
        question: (() => {
          const qWithImg = attachImage(1, question);
          return {
            id: qWithImg.id,
            text: qWithImg.question,
            optionA: qWithImg.optionA,
            optionB: qWithImg.optionB,
            optionC: qWithImg.optionC,
            optionD: qWithImg.optionD,
            imageUrl: null,
          };
        })(),
      });

    } catch (err: any) {
      app.log.error({ err }, "Erreur start quiz");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/games/:gameId/quiz/resume - Reprendre une session active et obtenir la question courante
  app.get("/api/games/:gameId/quiz/resume", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const user = (req as any).user;

    try {
      // Identifier le joueur (priorité header)
      const playerIdHeader = req.headers['x-player-id'] as string | undefined;
      const playerIdFromMiddleware = user.playerIdFromHeader as string | undefined;

      let player;
      if (playerIdHeader) {
        player = await prisma.player.findFirst({ where: { id: playerIdHeader, gameId } });
      } else if (playerIdFromMiddleware) {
        player = await prisma.player.findFirst({ where: { id: playerIdFromMiddleware, gameId } });
      } else if (user.guestId) {
        player = await prisma.player.findFirst({ where: { gameId, guestId: user.guestId } });
      }

      if (!player) {
        return reply.status(404).send({ error: "Joueur non trouvé" });
      }

      // Trouver la session active
      const activeSession = await prisma.quizSession.findFirst({
        where: { playerId: player.id, gameId, status: 'active' },
      });

      if (!activeSession) {
        return reply.status(404).send({ error: "Aucune session active à reprendre" });
      }

  // Déterminer la difficulté à partir de la question courante (règle dynamique)
  const difficulty = getDifficultyForQuestion(activeSession.currentQuestion);

    // Sélectionner une question non vue (enfant si Q<=2)
    if (activeSession.currentQuestion <= 2) {
      try { ensureKidsPool(450, 500).catch(() => {}); } catch {}
    }
    if (activeSession.currentQuestion <= 5 && activeSession.currentQuestion > 2) {
      try { ensureMediumPool(450, 500).catch(() => {}); } catch {}
    }
    // Plus de préchargement spécifique pour 'hard' (QI/Logique) — on reste générique
    const question = activeSession.currentQuestion <= 2
      ? await selectKidFriendlyQuestion(player.id, activeSession.id)
      : (activeSession.currentQuestion <= 5
          ? await selectUnseenQuestion(player.id, 'medium', activeSession.id)
          : await selectHardGeneric(player.id, activeSession.id));
      if (!question) {
        return reply.status(500).send({ error: "Aucune question disponible pour reprise" });
      }

      // Marquer comme vue
      await markQuestionAsSeen(player.id, question.id);

      return reply.send({
        session: {
          id: activeSession.id,
          currentQuestion: activeSession.currentQuestion,
          currentEarnings: activeSession.currentEarnings,
          securedAmount: 0,
          skipsLeft: (activeSession as any).skipsLeft ?? 0,
          nextPrize: getPrizeAmount(activeSession.currentQuestion),
        },
        question: (() => {
          const qWithImg = attachImage(activeSession.currentQuestion, question);
          return {
            id: qWithImg.id,
            text: qWithImg.question,
            optionA: qWithImg.optionA,
            optionB: qWithImg.optionB,
            optionC: qWithImg.optionC,
            optionD: qWithImg.optionD,
            imageUrl: qWithImg.imageUrl || null,
          };
        })(),
      });

    } catch (err: any) {
      app.log.error({ err }, "Erreur resume quiz");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/games/:gameId/quiz/answer - Répondre à la question actuelle
  app.post("/api/games/:gameId/quiz/answer", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({ 
      sessionId: z.string(),
      questionId: z.string(),
      answer: z.enum(['A', 'B', 'C', 'D'])
    });
    const { gameId } = paramsSchema.parse((req as any).params);
    const { sessionId, questionId, answer } = bodySchema.parse((req as any).body);
    const user = (req as any).user;

    try {
      const session = await prisma.quizSession.findUnique({
        where: { id: sessionId },
        include: { player: true },
      });

      if (!session || session.status !== 'active') {
        return reply.status(404).send({ error: "Session non trouvée ou terminée" });
      }

      // Vérifier que la session appartient bien à cette partie
      if (session.gameId !== gameId) {
        return reply.status(403).send({ error: "Cette session n'appartient pas à cette partie" });
      }

      // Note: On ne vérifie plus le guestId car les cookies cross-domain ne fonctionnent pas toujours
      // La sécurité est assurée par le fait que seul le joueur qui a le sessionId peut répondre
      app.log.info({ 
        sessionId, 
        sessionPlayerId: session.playerId, 
        gameId
      }, "Quiz answer - traitement réponse");

      const question = await prisma.quizQuestion.findUnique({
        where: { id: questionId },
      });

      if (!question) {
        return reply.status(404).send({ error: "Question non trouvée" });
      }

  const isCorrect = answer === question.correctAnswer;
  const currentPrizeAmount = getPrizeAmount(session.currentQuestion);
      const prizeBefore = session.currentEarnings;
      let prizeAfter = prizeBefore;
      let newStatus = session.status;
  let newSecuredAmount = 0;

      if (isCorrect) {
        // Bonne réponse: gains deviennent le montant de cette question
        prizeAfter = currentPrizeAmount;

        // Enregistrer la tentative
        await prisma.quizAttempt.create({
          data: {
            sessionId: session.id,
            questionId: question.id,
            questionNumber: session.currentQuestion,
            playerAnswer: answer,
            isCorrect: true,
            prizeBefore,
            prizeAfter,
          },
        });

        // Si c'était la 10e question, terminer la session avec réussite
        if (session.currentQuestion >= MAX_QUESTIONS) {
          await prisma.quizSession.update({
            where: { id: session.id },
            data: {
              status: 'completed',
              currentEarnings: prizeAfter,
              securedAmount: prizeAfter,
              completedAt: new Date(),
            },
          });

          await prisma.player.update({
            where: { id: session.playerId },
            data: {
              cash: { increment: prizeAfter },
              netWorth: { increment: prizeAfter },
              // Gains cumulés quiz (ajouter le prix final)
              cumulativeQuizGain: { increment: prizeAfter },
            },
          });

          return reply.send({
            correct: true,
            completed: true,
            finalPrize: prizeAfter,
            message: `Bravo ! Vous avez gagné $${prizeAfter.toLocaleString()} (10/10).`,
          });
        }

        // Passer à la question suivante
        await prisma.quizSession.update({
          where: { id: session.id },
          data: {
            currentQuestion: session.currentQuestion + 1,
            currentEarnings: prizeAfter,
            securedAmount: newSecuredAmount,
          },
        });

  // Récupérer la prochaine question (non vue) - enfant si Q<=4
  const nextDifficulty = getDifficultyForQuestion(session.currentQuestion + 1);
  if ((session.currentQuestion + 1) <= 2) {
    try { ensureKidsPool(450, 500).catch(() => {}); } catch {}
  }
  if ((session.currentQuestion + 1) <= 5 && (session.currentQuestion + 1) > 2) {
    try { ensureMediumPool(450, 500).catch(() => {}); } catch {}
  }
  // Plus de préchargement spécifique pour 'hard' (QI/Logique) — on reste générique
  const nextQuestion = (session.currentQuestion + 1) <= 2
    ? await selectKidFriendlyQuestion(session.player.id, session.id)
    : ((session.currentQuestion + 1) <= 5
        ? await selectUnseenQuestion(session.player.id, 'medium', session.id)
  : await selectHardGeneric(session.player.id, session.id));

        if (!nextQuestion) {
          return reply.status(500).send({ error: "Erreur chargement question suivante" });
        }

        // Marquer la nouvelle question comme vue
        await markQuestionAsSeen(session.player.id, nextQuestion.id);

        return reply.send({
          correct: true,
          completed: false,
          currentQuestion: session.currentQuestion + 1,
          currentEarnings: prizeAfter,
          securedAmount: newSecuredAmount,
          skipsLeft: (session as any).skipsLeft ?? 0,
          nextPrize: getPrizeAmount(session.currentQuestion + 1),
          question: (() => {
            const qWithImg = attachImage(session.currentQuestion + 1, nextQuestion);
            return {
              id: qWithImg.id,
              text: qWithImg.question,
              optionA: qWithImg.optionA,
              optionB: qWithImg.optionB,
              optionC: qWithImg.optionC,
              optionD: qWithImg.optionD,
              imageUrl: null,
            };
          })(),
        });

      } else {
  // Mauvaise réponse - quitte ou double: tout perdre
  prizeAfter = 0;

        await prisma.quizAttempt.create({
          data: {
            sessionId: session.id,
            questionId: question.id,
            questionNumber: session.currentQuestion,
            playerAnswer: answer,
            isCorrect: false,
            prizeBefore,
            prizeAfter,
          },
        });

        await prisma.quizSession.update({
          where: { id: session.id },
          data: {
            status: 'failed',
            currentEarnings: prizeAfter,
            completedAt: new Date(),
          },
        });

        // Ajouter l'argent au joueur si > 0
        if (prizeAfter > 0) {
          await prisma.player.update({
            where: { id: session.playerId },
            data: {
              cash: { increment: prizeAfter },
              netWorth: { increment: prizeAfter },
            },
          });
        }

        return reply.send({
          correct: false,
          failed: true,
          correctAnswer: question.correctAnswer,
          finalPrize: prizeAfter,
          message: "Dommage ! Vous avez tout perdu (quitte ou double).",
        });
      }

    } catch (err: any) {
      app.log.error({ err }, "Erreur answer quiz");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/games/:gameId/quiz/cash-out - Encaisser les gains actuels
  app.post("/api/games/:gameId/quiz/cash-out", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({ sessionId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const { sessionId } = bodySchema.parse((req as any).body);
    const user = (req as any).user;

    try {
      const session = await prisma.quizSession.findUnique({
        where: { id: sessionId },
        include: { player: true },
      });

      if (!session || session.status !== 'active') {
        return reply.status(404).send({ error: "Session non trouvée ou terminée" });
      }

      // Vérifier que la session appartient bien à cette partie
      if (session.gameId !== gameId) {
        return reply.status(403).send({ error: "Cette session n'appartient pas à cette partie" });
      }

      const finalPrize = session.currentEarnings;

      // Marquer la session comme encaissée
      await prisma.quizSession.update({
        where: { id: session.id },
        data: {
          status: 'cashed-out',
          completedAt: new Date(),
        },
      });

      // Ajouter l'argent au joueur
      if (finalPrize > 0) {
        await prisma.player.update({
          where: { id: session.playerId },
          data: {
            cash: { increment: finalPrize },
            netWorth: { increment: finalPrize },
            cumulativeQuizGain: { increment: finalPrize },
          },
        });
      }

      return reply.send({
        cashedOut: true,
        finalPrize,
        message: `Vous avez encaissé $${finalPrize.toLocaleString()} !`,
      });

    } catch (err: any) {
      app.log.error({ err }, "Erreur cash-out quiz");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/quiz/generate-ai - Générer des questions par IA (admin uniquement)
  app.post("/api/quiz/generate-ai", { preHandler: requireAdmin(app) }, async (req, reply) => {
    try {
      app.log.info("Génération manuelle de questions par IA...");
      const created = await generateAndSaveQuestions();
      
      return reply.send({
        success: true,
        created,
        message: `${created} questions générées avec succès`,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur génération manuelle IA");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/quiz/cleanup-duplicates - Audit et suppression des doublons (admin)
  app.post("/api/quiz/cleanup-duplicates", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const bodySchema = z.object({ threshold: z.number().min(0.5).max(0.95).default(0.8), dryRun: z.boolean().default(true) });
    const { threshold, dryRun } = bodySchema.parse((req as any).body || {});
    try {
      const result = await auditAndCleanupDuplicates(threshold, dryRun);
      return reply.send({ success: true, dryRun, ...result });
    } catch (err: any) {
      app.log.error({ err }, "Erreur cleanup duplicates");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/quiz/public-stats - Statistiques publiques (sans auth)
  app.get("/api/quiz/public-stats", async (req, reply) => {
    try {
      const [total, easy, medium, hard, finance, economy, realEstate] = await Promise.all([
        prisma.quizQuestion.count(),
        prisma.quizQuestion.count({ where: { difficulty: 'easy' } }),
        prisma.quizQuestion.count({ where: { difficulty: 'medium' } }),
        prisma.quizQuestion.count({ where: { difficulty: 'hard' } }),
        prisma.quizQuestion.count({ where: { category: 'finance' } }),
        prisma.quizQuestion.count({ where: { category: 'economy' } }),
        prisma.quizQuestion.count({ where: { category: 'real-estate' } }),
      ]);

      // Distinct questions déjà posées globalement
      const [usedTotal, usedEasy, usedMedium, usedHard] = await Promise.all([
        prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
        prisma.quizAttempt.findMany({ where: { question: { difficulty: 'easy' } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
        prisma.quizAttempt.findMany({ where: { question: { difficulty: 'medium' } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
        prisma.quizAttempt.findMany({ where: { question: { difficulty: 'hard' } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
      ]);

      const remaining = Math.max(0, total - usedTotal);
      const remainingByDifficulty = {
        easy: Math.max(0, easy - usedEasy),
        medium: Math.max(0, medium - usedMedium),
        hard: Math.max(0, hard - usedHard),
      } as const;

      const [usedFinance, usedEconomy, usedRealEstate] = await Promise.all([
        prisma.quizAttempt.findMany({ where: { question: { category: 'finance' } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
        prisma.quizAttempt.findMany({ where: { question: { category: 'economy' } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
        prisma.quizAttempt.findMany({ where: { question: { category: 'real-estate' } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
      ]);
      const remainingByCategory = {
        finance: Math.max(0, finance - usedFinance),
        economy: Math.max(0, economy - usedEconomy),
        realEstate: Math.max(0, realEstate - usedRealEstate),
      } as const;

      // Catégories dynamiques
      const distinctCats = await prisma.quizQuestion.findMany({ distinct: ["category"], select: { category: true } });
      const categories = [] as Array<{ category: string; total: number; used: number; remaining: number }>;
      for (const c of distinctCats) {
        const cat = c.category || 'uncategorized';
        const t = await prisma.quizQuestion.count({ where: { category: cat } });
  const u = await prisma.quizAttempt.findMany({ where: { question: { category: cat } }, distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length);
        categories.push({ category: cat, total: t, used: u, remaining: Math.max(0, t - u) });
      }

      return reply.send({
        questions: total,
        easy,
        medium,
        hard,
        finance,
        economy,
        realEstate,
        remaining,
        remainingByDifficulty,
        remainingByCategory,
        categories,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur stats questions publiques");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/quiz/trigger-generation - Déclencher génération (secret key)
  app.post("/api/quiz/trigger-generation", async (req, reply) => {
    try {
      const bodySchema = z.object({ secret: z.string().optional() });
      const body = typeof (req as any).body === 'string' ? JSON.parse((req as any).body) : ((req as any).body || {});
      const { secret } = bodySchema.parse(body);
      
      // Vérifier le secret (configurer QUIZ_GENERATION_SECRET dans .env)
      const expectedSecret = process.env.QUIZ_GENERATION_SECRET || "generate123";
      if (secret !== expectedSecret) {
        return reply.status(401).send({ error: "Secret invalide" });
      }

      app.log.info("🤖 Génération de questions déclenchée manuellement");
      const created = await generateAndSaveQuestions();
      
      return reply.send({
        success: true,
        created,
        message: `${created} questions générées avec succès`,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur génération déclenchée");
      return reply.status(500).send({ error: err.message });
    }
  });
  
  // GET /api/quiz/trigger-generation-get - Alternative GET pour tester facilement
  app.get("/api/quiz/trigger-generation-get", async (req, reply) => {
    try {
      const querySchema = z.object({ secret: z.string().optional() });
      const { secret } = querySchema.parse((req as any).query || {});
      
      const expectedSecret = process.env.QUIZ_GENERATION_SECRET || "generate123";
      if (secret !== expectedSecret) {
        return reply.status(401).send({ error: "Secret invalide - ajoutez ?secret=generate123" });
      }

      app.log.info("🤖 Génération de questions déclenchée via GET");
      const created = await generateAndSaveQuestions();
      
      return reply.send({
        success: true,
        created,
        message: `${created} questions générées avec succès`,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur génération GET");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/quiz/admin-purge - Purger jusqu'à N questions sans tentative (secret requis) et réappro optionnel
  app.get("/api/quiz/admin-purge", async (req, reply) => {
    try {
      const querySchema = z.object({
        secret: z.string().optional(),
        count: z.coerce.number().min(1).max(1000).optional(),
        replenish: z.coerce.number().optional(), // 1 pour activer
      });
      const { secret, count = 250, replenish = 1 } = querySchema.parse((req as any).query || {});

      const expectedSecret = process.env.QUIZ_GENERATION_SECRET || "generate123";
      if (secret !== expectedSecret) {
        return reply.status(401).send({ error: "Secret invalide - ajoutez ?secret=generate123" });
      }

      // Stats avant
      const [totalBefore, usedBefore] = await Promise.all([
        prisma.quizQuestion.count(),
  prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
      ]);
      const remainingBefore = Math.max(0, totalBefore - usedBefore);

      // Supprimer jusqu'à 'count' questions sans tentative (les plus anciennes)
      const deletable = await prisma.quizQuestion.findMany({
        where: { attempts: { none: {} } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: Math.min(1000, Math.max(1, count)),
      });
      let deleted = 0;
      if (deletable.length > 0) {
  const ids = deletable.map((d: { id: string }) => d.id);
        const del = await prisma.quizQuestion.deleteMany({ where: { id: { in: ids } } });
        deleted = del.count;
      }

      // Stats après
      const [totalAfter, usedAfter] = await Promise.all([
        prisma.quizQuestion.count(),
  prisma.quizAttempt.findMany({ distinct: ["questionId"], select: { questionId: true } }).then((r: Array<{ questionId: string }>) => r.length),
      ]);
      const remainingAfter = Math.max(0, totalAfter - usedAfter);

      // Réappro si demandé: maintenir le stock (<300 → viser 400)
      let created = 0;
      if (replenish === 1) {
        const res = await maintainQuestionStock(300, 400);
        created = res.created;
      }

      return reply.send({
        success: true,
        deleted,
        before: { total: totalBefore, used: usedBefore, remaining: remainingBefore },
        after: { total: totalAfter, used: usedAfter, remaining: remainingAfter },
        created,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur admin-purge");
      return reply.status(500).send({ error: err.message });
    }
  });
  
  // GET /api/quiz/reset-seen - Réinitialiser les questions vues (admin ou secret)
  app.get("/api/quiz/reset-seen", async (req, reply) => {
    try {
      const querySchema = z.object({ 
        secret: z.string().optional(),
        playerId: z.string().optional() 
      });
      const { secret, playerId } = querySchema.parse((req as any).query || {});
      
      const expectedSecret = process.env.QUIZ_GENERATION_SECRET || "generate123";
      if (secret !== expectedSecret) {
        return reply.status(401).send({ error: "Secret invalide - ajoutez ?secret=generate123" });
      }

      app.log.info("🔄 Réinitialisation des questions vues");
      
      let deleted;
      if (playerId) {
        // Réinitialiser pour un joueur spécifique
        deleted = await prisma.quizQuestionSeen.deleteMany({
          where: { playerId }
        });
        app.log.info({ playerId, count: deleted.count }, "Questions vues réinitialisées pour un joueur");
      } else {
        // Réinitialiser pour tous les joueurs
        deleted = await prisma.quizQuestionSeen.deleteMany({});
        app.log.info({ count: deleted.count }, "Questions vues réinitialisées pour tous");
      }
      
      return reply.send({
        success: true,
        deleted: deleted.count,
        message: `${deleted.count} entrées supprimées`,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur réinitialisation questions vues");
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/games/:gameId/quiz/grant-tokens - Ajouter des tokens (secret + identification flexible)
  app.get("/api/games/:gameId/quiz/grant-tokens", async (req, reply) => {
    try {
      const paramsSchema = z.object({ gameId: z.string() });
      const querySchema = z.object({
        secret: z.string().optional(),
        amount: z.coerce.number().optional(),
        playerId: z.string().optional(),
        nickname: z.string().optional(),
      });
      const { gameId } = paramsSchema.parse((req as any).params);
      const { secret, amount = 1, playerId, nickname } = querySchema.parse((req as any).query || {});

      const expectedSecret = process.env.QUIZ_GENERATION_SECRET || "generate123";
      if (secret !== expectedSecret) {
        return reply.status(401).send({ error: "Secret invalide - ajoutez ?secret=generate123" });
      }

      // Résoudre le joueur: priorités -> playerId param > nickname param > header X-Player-ID > cookie guestId
      let player = null as null | { id: string; nickname: string | null };

      if (playerId) {
        player = await prisma.player.findFirst({ where: { id: playerId, gameId }, select: { id: true, nickname: true } });
      }

      if (!player && nickname) {
        player = await prisma.player.findFirst({ where: { gameId, nickname }, select: { id: true, nickname: true } });
      }

      if (!player) {
        const headerId = req.headers['x-player-id'] as string | undefined;
        if (headerId) {
          player = await prisma.player.findFirst({ where: { id: headerId, gameId }, select: { id: true, nickname: true } });
        }
      }

      if (!player) {
        // Dernière chance: essayer via cookie guestId s'il est présent
        const guestId = (req as any).cookies?.hm_guest as string | undefined;
        if (guestId) {
          player = await prisma.player.findFirst({ where: { gameId, guestId }, select: { id: true, nickname: true } });
        }
      }

      if (!player) {
        return reply.status(404).send({ error: "Joueur non trouvé pour cette partie" });
      }

      const MAX_TOKENS = 20;
      const current = await prisma.player.findUnique({ where: { id: player.id }, select: { quizTokens: true } });
      if (!current) return reply.status(404).send({ error: "Joueur introuvable" });
      const next = Math.min(MAX_TOKENS, (current.quizTokens ?? 0) + amount);
      const updated = await prisma.player.update({
        where: { id: player.id },
        data: { quizTokens: next },
        select: { id: true, quizTokens: true, nickname: true },
      });

      return reply.send({
        success: true,
        playerId: updated.id,
        nickname: updated.nickname,
        tokens: updated.quizTokens,
        added: Math.max(0, next - (current.quizTokens ?? 0)),
        message: `${Math.max(0, next - (current.quizTokens ?? 0))} token(s) ajouté(s)`,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur grant-tokens");
      return reply.status(500).send({ error: err.message });
    }
  });
}
