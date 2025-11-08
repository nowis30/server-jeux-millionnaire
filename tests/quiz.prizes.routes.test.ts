import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/prisma';
import { registerGameRoutes } from '../src/routes/games';
import { registerAuthRoutes } from '../src/routes/auth';
import { registerQuizRoutes } from '../src/routes/quiz';

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  await app.register(require('@fastify/cookie'));
  await registerAuthRoutes(app);
  await registerGameRoutes(app);
  await registerQuizRoutes(app);
  return app;
}

async function main() {
  const app = await build();

  // Créer partie et joueur simple
  const gamesResp = await app.inject({ method: 'GET', url: '/api/games' });
  if (gamesResp.statusCode !== 200) throw new Error('Liste jeux échouée');
  const gamesBody = gamesResp.json() as { games: Array<{ id: string; code: string }> };
  const gameId = gamesBody.games[0]?.id;
  if (!gameId) throw new Error('GameId introuvable');

  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const player = await prisma.player.create({ data: { nickname: `quiz_tester_${uniq}`, cash: 0, netWorth: 0, gameId, guestId: `guest-quiz-${uniq}` } });

  // Injecter un jeu minimal de questions pour éviter dépendance à la génération IA
  const seedDistinct = async () => {
    const easyQs = [
      { cat: 'kids', text: 'Combien de pattes a une araignée ?' },
      { cat: 'kids', text: 'Quel fruit tombe de l\'arbre de Newton ?' },
      { cat: 'kids', text: 'Quelle couleur obtient-on en mélangeant bleu et jaune ?' },
      { cat: 'kids', text: 'Quel animal miaule et boit du lait ?' },
    ];
    for (const e of easyQs) {
      await prisma.quizQuestion.create({ data: { difficulty: 'easy', category: e.cat, question: e.text, optionA: 'Bonne', optionB: 'Mauvaise1', optionC: 'Mauvaise2', optionD: 'Mauvaise3', correctAnswer: 'A' } });
    }
    const medQs = [
      { cat: 'definitions', text: 'Quelle est la définition de l\'inflation en économie ?' },
      { cat: 'quebec', text: 'Quel fleuve traverse la ville de Québec ?' },
      { cat: 'religions', text: 'Quel est le nom du jeûne annuel pratiqué par les musulmans ?' },
    ];
    for (const m of medQs) {
      await prisma.quizQuestion.create({ data: { difficulty: 'medium', category: m.cat, question: m.text, optionA: 'Bonne', optionB: 'Mauvaise1', optionC: 'Mauvaise2', optionD: 'Mauvaise3', correctAnswer: 'A' } });
    }
    const hardQs = [
      { cat: 'general', text: 'Dans quel roman de Proust trouve-t-on la madeleine ?' },
      { cat: 'science', text: 'Quelle particule élémentaire porte une charge électrique négative ?' },
      { cat: 'history', text: 'En quelle année a eu lieu la bataille d\'Hastings ?' },
      { cat: 'geography', text: 'Quel est le plus grand désert chaud du monde ?' },
      { cat: 'art', text: 'Quel peintre a réalisé Guernica ?' },
    ];
    for (const h of hardQs) {
      await prisma.quizQuestion.create({ data: { difficulty: 'hard', category: h.cat, question: h.text, optionA: 'Bonne', optionB: 'Mauvaise1', optionC: 'Mauvaise2', optionD: 'Mauvaise3', correctAnswer: 'A' } });
    }
  };
  await seedDistinct();

  // Démarrer une session via header X-Player-ID (bypass cookies)
  const start = await app.inject({ method: 'POST', url: `/api/games/${gameId}/quiz/start`, headers: { 'x-player-id': player.id } });
  if (start.statusCode !== 200) throw new Error(`Start échoué: ${start.statusCode} ${start.body}`);
  const s = start.json() as { sessionId: string; currentQuestion: number; nextPrize: number };

  // Vérifier mise de départ 50000
  if (s.nextPrize !== 50000) throw new Error(`Mise de départ inattendue: ${s.nextPrize}`);

  let sessionId = s.sessionId;
  let currentQuestion = 1;
  let expectedNext = 50000;

  // Boucle de progression: à chaque étape reprendre pour obtenir la question
  for (let q = 1; q <= 10; q++) {
    const resume = q === 1 ? start : await app.inject({ method: 'GET', url: `/api/games/${gameId}/quiz/resume`, headers: { 'x-player-id': player.id } });
    if (resume.statusCode !== 200) throw new Error(`Resume échoué Q${q}: ${resume.statusCode} ${resume.body}`);
    const r = resume.json() as any;
    const questionId = r.question.id;

    // Récupérer la bonne réponse
    const qRow = await prisma.quizQuestion.findUnique({ where: { id: questionId } });
    if (!qRow) throw new Error('Question introuvable');

    const ans = qRow.correctAnswer as 'A'|'B'|'C'|'D';
    const answer = await app.inject({ method: 'POST', url: `/api/games/${gameId}/quiz/answer`, headers: { 'x-player-id': player.id }, payload: { sessionId, questionId, answer: ans } });
    if (answer.statusCode !== 200) throw new Error(`Answer échoué Q${q}: ${answer.statusCode} ${answer.body}`);
    const a = answer.json() as any;

    // Après chaque bonne réponse sauf la 10e, nextPrize doit doubler
    if (q < 10) {
      expectedNext = expectedNext * 2;
      if (a.nextPrize !== expectedNext) throw new Error(`nextPrize inattendu après Q${q}: attendu ${expectedNext}, obtenu ${a.nextPrize}`);
      currentQuestion++;
    } else {
      if (!a.completed || a.finalPrize !== 25600000) throw new Error(`Final prize inattendu: ${JSON.stringify(a)}`);
    }
  }

  console.log('QUIZ PRIZES TEST: PASS');
  await app.close();
}

main().then(() => process.exit(0)).catch(err => { console.error('QUIZ PRIZES TEST: FAIL', err); process.exit(1); });
