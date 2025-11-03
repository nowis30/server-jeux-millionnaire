"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSocket = setupSocket;
const socket_io_1 = require("socket.io");
const env_1 = require("./env");
function setupSocket(server) {
    const io = new socket_io_1.Server(server, {
        cors: { origin: env_1.env.CLIENT_ORIGINS, credentials: true },
    });
    io.on("connection", (socket) => {
        const { gameId } = socket.handshake.query;
        if (gameId)
            socket.join(`game:${gameId}`);
        socket.on("join-game", (gid) => socket.join(`game:${gid}`));
    });
    return {
        io,
        emitLeaderboard(gameId, leaderboard) {
            const payload = {
                gameId,
                at: new Date().toISOString(),
                leaderboard,
            };
            io.to(`game:${gameId}`).emit("hourly-tick", payload);
        },
    };
}
