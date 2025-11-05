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

// Structure des gains par question (Quitte ou Double)
const PRIZE_LADDER = [
  { question: 1, amount: 1000, difficulty: 'easy', milestone: false },
  { question: 2, amount: 2000, difficulty: 'easy', milestone: false },
  { question: 3, amount: 3000, difficulty: 'easy', milestone: false },
  { question: 4, amount: 4000, difficulty: 'easy', milestone: false },
  { question: 5, amount: 5000, difficulty: 'easy', milestone: true },  // Palier 1
  { question: 6, amount: 10000, difficulty: 'medium', milestone: false },
  { question: 7, amount: 20000, difficulty: 'medium', milestone: false },
  { question: 8, amount: 30000, difficulty: 'medium', milestone: false },
  { question: 9, amount: 40000, difficulty: 'medium', milestone: false },
  { question: 10, amount: 50000, difficulty: 'medium', milestone: true },  // Palier 2
  { question: 11, amount: 75000, difficulty: 'hard', milestone: false },
  { question: 12, amount: 100000, difficulty: 'hard', milestone: false },
  { question: 13, amount: 150000, difficulty: 'hard', milestone: false },
  { question: 14, amount: 250000, difficulty: 'hard', milestone: false },
  { question: 15, amount: 500000, difficulty: 'hard', milestone: true },  // Palier 3
  { question: 16, amount: 750000, difficulty: 'hard', milestone: false },
  { question: 17, amount: 1000000, difficulty: 'hard', milestone: false },
  { question: 18, amount: 1500000, difficulty: 'hard', milestone: false },
  { question: 19, amount: 2500000, difficulty: 'hard', milestone: false },
  { question: 20, amount: 5000000, difficulty: 'hard', milestone: true },  // Palier final
];

const COOLDOWN_MINUTES = 60;

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
        const currentPrize = PRIZE_LADDER[activeSession.currentQuestion - 1];
        return reply.send({
          canPlay: true,
          hasActiveSession: true,
          tokens: currentTokens,
          secondsUntilNextToken,
          session: {
            id: activeSession.id,
            currentQuestion: activeSession.currentQuestion,
            currentEarnings: activeSession.currentEarnings,
            securedAmount: activeSession.securedAmount,
            nextPrize: currentPrize?.amount || 0,
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
        nextPrize: PRIZE_LADDER[0].amount,
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

      // Déterminer la difficulté à partir de la question courante
      const prizeInfo = PRIZE_LADDER[activeSession.currentQuestion - 1];
      const difficulty = prizeInfo?.difficulty || 'easy';

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
          securedAmount: activeSession.securedAmount,
          nextPrize: prizeInfo?.amount || 0,
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
      const currentPrize = PRIZE_LADDER[session.currentQuestion - 1];
      const prizeBefore = session.currentEarnings;
      let prizeAfter = prizeBefore;
      let newStatus = session.status;
      let newSecuredAmount = session.securedAmount;

      if (isCorrect) {
        // Bonne réponse
        prizeAfter = currentPrize.amount;
        
        // Vérifier si c'est un palier
        if (currentPrize.milestone) {
          newSecuredAmount = prizeAfter;
        }

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

        // Vérifier si c'est la dernière question
        if (session.currentQuestion >= PRIZE_LADDER.length) {
          // Partie terminée avec succès !
          await prisma.quizSession.update({
            where: { id: session.id },
            data: {
              status: 'completed',
              currentEarnings: prizeAfter,
              securedAmount: prizeAfter,
              completedAt: new Date(),
            },
          });

          // Ajouter l'argent au joueur
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
            message: `Félicitations ! Vous avez gagné $${prizeAfter.toLocaleString()} !`,
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
        const nextPrizeInfo = PRIZE_LADDER[session.currentQuestion];
        const nextQuestion = await selectUnseenQuestion(session.player.id, nextPrizeInfo.difficulty);

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
          nextPrize: nextPrizeInfo.amount,
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
        // Mauvaise réponse - retour au dernier palier
        prizeAfter = newSecuredAmount;

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

        // Ajouter l'argent sécurisé au joueur
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
          message: prizeAfter > 0 
            ? `Dommage ! Vous repartez avec $${prizeAfter.toLocaleString()}.` 
            : "Dommage ! Vous n'avez rien gagné.",
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
}
