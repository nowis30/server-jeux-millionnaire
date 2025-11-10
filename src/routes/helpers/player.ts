import { FastifyInstance } from "fastify";
import { prisma } from "../../prisma";

const PLAYER_SELECT = {
  id: true,
  gameId: true,
  cash: true,
  netWorth: true,
  lastAdQuizAt: true,
  guestId: true,
  nickname: true,
} as const;

export async function resolvePlayerForRequest(app: FastifyInstance, req: any, gameId: string) {
  const headerPlayerId = (req.headers?.["x-player-id"] as string | undefined) || (req.user?.playerIdFromHeader as string | undefined);
  if (headerPlayerId) {
    const byHeader = await prisma.player.findFirst({ where: { id: headerPlayerId, gameId }, select: PLAYER_SELECT });
    if (byHeader) return byHeader;
  }

  const guestId = (req.user?.guestId as string | undefined) || (req.cookies?.["hm_guest"] as string | undefined);
  if (guestId) {
    const byGuest = await prisma.player.findFirst({ where: { gameId, guestId }, select: PLAYER_SELECT });
    if (byGuest) return byGuest;
  }

  const email = req.user?.email as string | undefined;
  if (email) {
    const byEmail = await prisma.player.findFirst({ where: { gameId, nickname: { equals: email, mode: "insensitive" } }, select: PLAYER_SELECT });
    if (byEmail) return byEmail;
  }

  return null;
}