import { FastifyInstance } from "fastify";

export async function assertGameRunning(app: FastifyInstance, gameId: string) {
  const game = await app.prisma.game.findUnique({ where: { id: gameId }, select: { status: true } });
  if (!game) throw new Error("Game introuvable");
  if (game.status !== "running") throw new Error("Partie terminée ou non démarrée");
}
