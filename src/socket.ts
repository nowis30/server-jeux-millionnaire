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
        // autoriser localhost en dev (http et https, avec/sans port)
        if (origin.startsWith("http://localhost:")) return callback(null, true);
        if (origin.startsWith("https://localhost:")) return callback(null, true);
        if (origin === "http://localhost" || origin === "https://localhost") return callback(null, true);
        // autoriser Capacitor (app mobile)
        if (origin === "capacitor://localhost") return callback(null, true);
        return callback(new Error("Origin not allowed"));
      },
    },
  });

  // expose io via référence module pour émissions hors routes (ex: simulation)
  ioRef = io;

  io.on("connection", (socket) => {
    // Suivi des rooms game:* pour ce socket
    (socket.data as any).joinedGames = new Set<string>();
    (socket.data as any).nickname = undefined as undefined | string;

    function inc(gid: string) {
      const cur = onlineByGame.get(gid) || 0;
      onlineByGame.set(gid, cur + 1);
      io.to(`game:${gid}`).emit("online-count", { gameId: gid, online: cur + 1 });
      const nick = (socket.data as any).nickname;
      if (nick) {
        let m = onlineUsersByGame.get(gid);
        if (!m) { m = new Map<string, number>(); onlineUsersByGame.set(gid, m); }
        m.set(nick, (m.get(nick) || 0) + 1);
      }
    }
    function dec(gid: string) {
      const cur = onlineByGame.get(gid) || 0;
      const next = Math.max(0, cur - 1);
      onlineByGame.set(gid, next);
      io.to(`game:${gid}`).emit("online-count", { gameId: gid, online: next });
      const nick = (socket.data as any).nickname;
      if (nick) {
        const m = onlineUsersByGame.get(gid);
        if (m) {
          const c = (m.get(nick) || 0) - 1;
          if (c <= 0) m.delete(nick); else m.set(nick, c);
        }
      }
    }

    const { gameId, nickname } = socket.handshake.query as { gameId?: string; nickname?: string };
    if (nickname && typeof nickname === 'string') {
      (socket.data as any).nickname = nickname;
    }
    if (gameId) {
      socket.join(`game:${gameId}`);
      (socket.data as any).joinedGames.add(gameId);
      inc(gameId);
    }

    socket.on("join-game", (gid: string, nick?: string) => {
      if (!gid) return;
      if (nick && typeof nick === 'string') {
        (socket.data as any).nickname = nick;
      }
      if (!(socket.data as any).joinedGames.has(gid)) {
        socket.join(`game:${gid}`);
        (socket.data as any).joinedGames.add(gid);
        inc(gid);
      }
    });

    socket.on("presence", (payload: { nickname?: string }) => {
      if (payload?.nickname && typeof payload.nickname === 'string') {
        (socket.data as any).nickname = payload.nickname;
      }
    });

    socket.on("disconnecting", () => {
      const joined: Set<string> = (socket.data as any).joinedGames || new Set();
      for (const gid of joined) dec(gid);
    });
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

// Compteurs en ligne par partie
const onlineByGame = new Map<string, number>();
const onlineUsersByGame = new Map<string, Map<string, number>>();
export function getOnlineCount(gameId: string): number {
  return onlineByGame.get(gameId) || 0;
}
export function getOnlineUsers(gameId: string): string[] {
  const m = onlineUsersByGame.get(gameId);
  if (!m) return [];
  return Array.from(m.keys()).sort((a, b) => a.localeCompare(b));
}
