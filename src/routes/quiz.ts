import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { z } from "zod";
import { requireUser } from "./auth";

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

export async function registerQuizRoutes(app: FastifyInstance) {
  
  // GET /api/games/:gameId/quiz/status - Vérifier si le joueur peut jouer
  app.get("/api/games/:gameId/quiz/status", { preHandler: requireUser(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const user = (req as any).user;

    try {
      // Trouver le joueur
      const player = await prisma.player.findFirst({
        where: { gameId, guestId: user.guestId },
      });

      if (!player) {
        return reply.status(404).send({ error: "Joueur non trouvé" });
      }

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
          session: {
            id: activeSession.id,
            currentQuestion: activeSession.currentQuestion,
            currentEarnings: activeSession.currentEarnings,
            securedAmount: activeSession.securedAmount,
            nextPrize: currentPrize?.amount || 0,
          },
        });
      }

      // Vérifier la dernière session terminée pour le cooldown
      const lastSession = await prisma.quizSession.findFirst({
        where: {
          playerId: player.id,
          gameId,
          status: { in: ['completed', 'failed', 'cashed-out'] },
        },
        orderBy: { completedAt: 'desc' },
      });

      if (lastSession && lastSession.completedAt) {
        const now = new Date();
        const cooldownEnd = new Date(lastSession.completedAt.getTime() + COOLDOWN_MINUTES * 60 * 1000);
        
        if (now < cooldownEnd) {
          const remainingMinutes = Math.ceil((cooldownEnd.getTime() - now.getTime()) / (60 * 1000));
          return reply.send({
            canPlay: false,
            hasActiveSession: false,
            cooldown: {
              remainingMinutes,
              nextAvailable: cooldownEnd.toISOString(),
            },
          });
        }
      }

      return reply.send({
        canPlay: true,
        hasActiveSession: false,
      });

    } catch (err: any) {
      app.log.error({ err }, "Erreur status quiz");
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/games/:gameId/quiz/start - Démarrer une nouvelle session
  app.post("/api/games/:gameId/quiz/start", { preHandler: requireUser(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const user = (req as any).user;

    try {
      const player = await prisma.player.findFirst({
        where: { gameId, guestId: user.guestId },
      });

      if (!player) {
        return reply.status(404).send({ error: "Joueur non trouvé" });
      }

      // Vérifier qu'il n'y a pas de session active
      const existingActive = await prisma.quizSession.findFirst({
        where: { playerId: player.id, gameId, status: 'active' },
      });

      if (existingActive) {
        return reply.status(400).send({ error: "Vous avez déjà une session en cours" });
      }

      // Vérifier le cooldown
      const lastSession = await prisma.quizSession.findFirst({
        where: {
          playerId: player.id,
          gameId,
          status: { in: ['completed', 'failed', 'cashed-out'] },
        },
        orderBy: { completedAt: 'desc' },
      });

      if (lastSession && lastSession.completedAt) {
        const now = new Date();
        const cooldownEnd = new Date(lastSession.completedAt.getTime() + COOLDOWN_MINUTES * 60 * 1000);
        
        if (now < cooldownEnd) {
          return reply.status(429).send({ error: "Veuillez attendre avant de rejouer" });
        }
      }

      // Créer une nouvelle session
      const session = await prisma.quizSession.create({
        data: {
          playerId: player.id,
          gameId,
          status: 'active',
          currentQuestion: 1,
          currentEarnings: 0,
          securedAmount: 0,
        },
      });

      // Récupérer une question facile aléatoire
      const question = await prisma.quizQuestion.findFirst({
        where: { difficulty: 'easy' },
        orderBy: { id: 'asc' },
        skip: Math.floor(Math.random() * 10), // Random parmi les 10 faciles
      });

      if (!question) {
        return reply.status(500).send({ error: "Aucune question disponible" });
      }

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

  // POST /api/games/:gameId/quiz/answer - Répondre à la question actuelle
  app.post("/api/games/:gameId/quiz/answer", { preHandler: requireUser(app) }, async (req, reply) => {
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

      if (session.player.guestId !== user.guestId) {
        return reply.status(403).send({ error: "Pas votre session" });
      }

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

        // Récupérer la prochaine question
        const nextPrizeInfo = PRIZE_LADDER[session.currentQuestion];
        const nextQuestion = await prisma.quizQuestion.findFirst({
          where: { difficulty: nextPrizeInfo.difficulty },
          orderBy: { id: 'asc' },
          skip: Math.floor(Math.random() * 10),
        });

        if (!nextQuestion) {
          return reply.status(500).send({ error: "Erreur chargement question suivante" });
        }

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
  app.post("/api/games/:gameId/quiz/cash-out", { preHandler: requireUser(app) }, async (req, reply) => {
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

      if (session.player.guestId !== user.guestId) {
        return reply.status(403).send({ error: "Pas votre session" });
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
}
