import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireUserOrGuest } from "./auth";
import { env } from "../env";

async function resolvePlayer(app: FastifyInstance, req: any, gameId: string) {
  const user = req.user;
  const playerIdHeader = req.headers['x-player-id'] as string | undefined;
  const playerIdFromMiddleware = user?.playerIdFromHeader as string | undefined;
  let player: any = null;
  if (playerIdHeader) {
    player = await prisma.player.findFirst({ where: { id: playerIdHeader, gameId } });
  } else if (playerIdFromMiddleware) {
    player = await prisma.player.findFirst({ where: { id: playerIdFromMiddleware, gameId } });
  } else if (user?.guestId) {
    player = await prisma.player.findFirst({ where: { gameId, guestId: user.guestId } });
  }
  return player;
}

export async function registerReferralRoutes(app: FastifyInstance) {
  // Créer un lien d'invitation
  app.post("/api/games/:gameId/referrals/create", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    try {
      const player = await resolvePlayer(app, req as any, gameId);
      if (!player) return reply.status(404).send({ error: "Joueur non trouvé" });
      const { nanoid } = await import("nanoid");
      const code = nanoid(10);
      const invite = await (prisma as any).referralInvite.create({
        data: { gameId, inviterId: player.id, code },
      });
      const base = env.APP_ORIGIN || (env.CLIENT_ORIGINS[0] || "http://localhost:3000");
      const url = `${base}/?invite=${code}`;
      return reply.send({ code, url, reward: invite.rewardAmount });
    } catch (err: any) {
      app.log.error({ err }, "Erreur création invitation");
      return reply.status(500).send({ error: err.message });
    }
  });

  // Accepter une invitation
  app.post("/api/games/:gameId/referrals/accept", { preHandler: requireUserOrGuest(app) }, async (req, reply) => {
    const paramsSchema = z.object({ gameId: z.string() });
    const bodySchema = z.object({ code: z.string() });
    const { gameId } = paramsSchema.parse((req as any).params);
    const { code } = bodySchema.parse((req as any).body || {});
    try {
      const player = await resolvePlayer(app, req as any, gameId);
      if (!player) return reply.status(404).send({ error: "Joueur non trouvé" });
  const invite = await (prisma as any).referralInvite.findUnique({ where: { code } });
      if (!invite || invite.gameId !== gameId) return reply.status(404).send({ error: "Invitation invalide" });
      if (invite.status !== 'pending') return reply.status(400).send({ error: "Invitation déjà utilisée" });
      if (invite.inviterId === player.id) return reply.status(400).send({ error: "Vous ne pouvez pas accepter votre propre invitation" });

      // Accepter + créditer l'invitant
      await prisma.$transaction([
        (prisma as any).referralInvite.update({
          where: { id: invite.id },
          data: { status: 'accepted', acceptedById: player.id, acceptedAt: new Date() },
        }),
        prisma.player.update({
          where: { id: invite.inviterId },
          data: { cash: { increment: invite.rewardAmount }, netWorth: { increment: invite.rewardAmount } },
        }),
      ]);

      return reply.send({ accepted: true, reward: invite.rewardAmount });
    } catch (err: any) {
      app.log.error({ err }, "Erreur acceptation invitation");
      return reply.status(500).send({ error: err.message });
    }
  });
}
