import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { z } from "zod";
import { requireUserOrGuest, requireAdmin } from "./auth";
import { generateAndSaveQuestions } from "../services/aiQuestions";
import {
  updatePlayerTokens,
  consumeQuizToken,
  refundQuizToken,
  getTimeUntilNextToken,
} from "../services/quizTokens";

// Règle Quitte ou Double: démarrage à 5000$ et double à chaque bonne réponse
const BASE_STAKE = 5000;
const getPrizeAmount = (questionNumber: number) => BASE_STAKE * Math.pow(2, Math.max(0, questionNumber - 1));
const getDifficultyForQuestion = (questionNumber: number): 'easy' | 'medium' | 'hard' => {
  if (questionNumber <= 5) return 'easy';
  if (questionNumber <= 10) return 'medium';
  return 'hard';
};

const COOLDOWN_MINUTES = 60;
const MAX_QUESTIONS = 10;

// Fonction pour sélectionner une question aléatoire non vue par le joueur
async function selectUnseenQuestion(playerId: string, difficulty: string): Promise<any> {
  // Compter d'abord le total de questions de cette difficulté
  const totalCount = await prisma.quizQuestion.count({
    where: { difficulty },
  });
  
  if (totalCount === 0) {
    return null; // Aucune question de cette difficulté
  }
  
  // Récupérer les IDs des questions déjà vues pour cette difficulté
  const seenQuestions = await prisma.quizQuestionSeen.findMany({
    where: { 
      playerId,
      question: { difficulty }
    },
    select: { questionId: true },
  });
  
  const seenIds = seenQuestions.map(sq => sq.questionId);
  const seenCount = seenIds.length;
  
  // Si le joueur a vu toutes les questions, réinitialiser
  if (seenCount >= totalCount) {
    await prisma.quizQuestionSeen.deleteMany({
      where: {
        playerId,
        question: { difficulty },
      },
    });
    // Prendre une question au hasard après réinitialisation
    const skip = Math.floor(Math.random() * totalCount);
    return await prisma.quizQuestion.findFirst({
      where: { difficulty },
      skip,
    });
  }
  
  // Il reste des questions non vues
  const unseenCount = totalCount - seenCount;
  
  if (unseenCount > 0) {
    // Prendre une question non vue au hasard
    const skip = Math.floor(Math.random() * unseenCount);
    return await prisma.quizQuestion.findFirst({
      where: {
        difficulty,
        id: { notIn: seenIds },
      },
      skip,
    });
  }
  
  // Fallback: prendre n'importe quelle question (ne devrait jamais arriver)
  const skip = Math.floor(Math.random() * totalCount);
  return await prisma.quizQuestion.findFirst({
    where: { difficulty },
    skip,
  });
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

      if (activeSession) {
        const currentPrizeAmount = getPrizeAmount(activeSession.currentQuestion);
        return reply.send({
          canPlay: true,
          hasActiveSession: true,
          tokens: currentTokens,
          secondsUntilNextToken,
          session: {
            id: activeSession.id,
            currentQuestion: activeSession.currentQuestion,
            currentEarnings: activeSession.currentEarnings,
            securedAmount: 0,
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
      });

    } catch (err: any) {
      app.log.error({ err }, "Erreur status quiz");
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

      // Récupérer une question facile non vue
      const question = await selectUnseenQuestion(player.id, 'easy');

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
        nextPrize: getPrizeAmount(1),
        question: {
          id: question.id,
          text: question.question,
          optionA: question.optionA,
          optionB: question.optionB,
          optionC: question.optionC,
          optionD: question.optionD,
        },
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

      // Sélectionner une question non vue
      const question = await selectUnseenQuestion(player.id, difficulty);
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
          nextPrize: getPrizeAmount(activeSession.currentQuestion),
        },
        question: {
          id: question.id,
          text: question.question,
          optionA: question.optionA,
          optionB: question.optionB,
          optionC: question.optionC,
          optionD: question.optionD,
        },
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

  // Récupérer la prochaine question (non vue)
  const nextDifficulty = getDifficultyForQuestion(session.currentQuestion + 1);
  const nextQuestion = await selectUnseenQuestion(session.player.id, nextDifficulty);

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
          nextPrize: getPrizeAmount(session.currentQuestion + 1),
          question: {
            id: nextQuestion.id,
            text: nextQuestion.question,
            optionA: nextQuestion.optionA,
            optionB: nextQuestion.optionB,
            optionC: nextQuestion.optionC,
            optionD: nextQuestion.optionD,
          },
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

  // GET /api/quiz/stats - Statistiques des questions (admin)
  app.get("/api/quiz/stats", { preHandler: requireAdmin(app) }, async (req, reply) => {
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

      return reply.send({
        total,
        byDifficulty: { easy, medium, hard },
        byCategory: { finance, economy, realEstate },
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur stats questions");
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

      return reply.send({
        questions: total,
        easy,
        medium,
        hard,
        finance,
        economy,
        realEstate,
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

      const updated = await prisma.player.update({
        where: { id: player.id },
        data: { quizTokens: { increment: amount } },
        select: { id: true, quizTokens: true, nickname: true },
      });

      return reply.send({
        success: true,
        playerId: updated.id,
        nickname: updated.nickname,
        tokens: updated.quizTokens,
        added: amount,
        message: `${amount} token(s) ajouté(s)`,
      });
    } catch (err: any) {
      app.log.error({ err }, "Erreur grant-tokens");
      return reply.status(500).send({ error: err.message });
    }
  });
}
