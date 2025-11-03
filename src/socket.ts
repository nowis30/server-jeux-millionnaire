import { Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "http";
import { LeaderboardEntry, HourlyTickEvent } from "@hm/shared";
import { env } from "./env";

export function setupSocket(server: HTTPServer) {
  const io = new SocketIOServer(server, {
    cors: { origin: env.CLIENT_ORIGINS, credentials: true },
  });

  io.on("connection", (socket) => {
    const { gameId } = socket.handshake.query as { gameId?: string };
    if (gameId) socket.join(`game:${gameId}`);

    socket.on("join-game", (gid: string) => socket.join(`game:${gid}`));
  });

  return {
    io,
    emitLeaderboard(gameId: string, leaderboard: LeaderboardEntry[]) {
      const payload: HourlyTickEvent = {
        gameId,
        at: new Date().toISOString(),
        leaderboard,
      };
      io.to(`game:${gameId}`).emit("hourly-tick", payload);
    },
  };
}
