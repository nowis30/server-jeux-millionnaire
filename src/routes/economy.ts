import { FastifyInstance, RouteHandlerMethod } from "fastify";
import { z } from "zod";

// Déterminisme léger pour une planification d'appréciation future sans persistance
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export async function registerEconomyRoutes(app: FastifyInstance) {
  const registerGet = (path: string, handler: RouteHandlerMethod) => {
    app.get(path, handler);
    if (!path.endsWith("/")) {
      app.get(`${path}/`, handler);
    }
  };

  registerGet("/api/games/:gameId/economy", async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const g = await (app.prisma as any).game.findUnique({ where: { id: gameId }, select: { baseMortgageRate: true, appreciationAnnual: true, inflationAnnual: true, inflationIndex: true, startedAt: true } });
    if (!g) return reply.status(404).send({ error: "Partie introuvable" });

    // Planifier 10 ans d'appréciations futures de manière déterministe à partir du gameId et de l'année courante
    const now = new Date();
    const baseYear = now.getUTCFullYear();
    const rng = mulberry32(hashString(`${gameId}:${baseYear}`));
    const schedule: number[] = [];
    for (let i = 0; i < 10; i++) {
      if (i === 0) {
        schedule.push(Number(g.appreciationAnnual ?? 0.03));
      } else {
        // Tirage indépendant dans [2%,5%]
        const val = 0.02 + rng() * 0.03;
        schedule.push(Number(val.toFixed(4)));
      }
    }
    return reply.send({
      baseMortgageRate: Number(g.baseMortgageRate ?? 0.05),
      appreciationAnnual: Number(g.appreciationAnnual ?? 0.03),
      inflationAnnual: Number(g.inflationAnnual ?? 0.02),
      inflationIndex: Number(g.inflationIndex ?? 1),
      schedule,
    });
  });
}
