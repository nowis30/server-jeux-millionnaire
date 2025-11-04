import { Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "http";
import { env } from "./env";

// Types locaux équivalents à ceux qui étaient fournis par @hm/shared
export interface LeaderboardEntry {
  playerId: string;
  nickname: string;
  netWorth: number;
}

export interface HourlyTickEvent {
  gameId: string;
  at: string; // ISO
  leaderboard: LeaderboardEntry[];
}

export function setupSocket(server: HTTPServer) {
  // Aligner la logique CORS Socket.IO sur celle du HTTP (Fastify)
  const io = new SocketIOServer(server, {
    cors: {
      credentials: true,
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // autoriser requêtes serveur-à-serveur et outils (origin nul)
        if (!origin) return callback(null, true);
        if (env.CLIENT_ORIGINS.includes(origin)) return callback(null, true);
        // autoriser tous les déploiements Vercel (prod/preview)
        if (/\.vercel\.app$/.test(origin)) return callback(null, true);
        // autoriser localhost en dev
        if (origin.startsWith("http://localhost:")) return callback(null, true);
        return callback(new Error("Origin not allowed"));
      },
    },
  });

  // expose io via référence module pour émissions hors routes (ex: simulation)
  ioRef = io;

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

// Référence IO module-scoped + helper pour émettre un event-feed depuis n'importe où
let ioRef: SocketIOServer | null = null;
export function sendEventFeed(gameId: string, event: any) {
  try {
    ioRef?.to(`game:${gameId}`).emit("event-feed", event);
  } catch {}
}
