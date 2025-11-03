"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertGameRunning = assertGameRunning;
async function assertGameRunning(app, gameId) {
    const game = await app.prisma.game.findUnique({ where: { id: gameId }, select: { status: true } });
    if (!game)
        throw new Error("Game introuvable");
    if (game.status !== "running")
        throw new Error("Partie terminée ou non démarrée");
}
