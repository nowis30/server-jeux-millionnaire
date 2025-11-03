"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const cookie_1 = __importDefault(require("@fastify/cookie"));
const env_1 = require("./env");
const games_1 = require("./routes/games");
const socket_1 = require("./socket");
const node_cron_1 = __importDefault(require("node-cron"));
const simulation_1 = require("./services/simulation");
const properties_1 = require("./routes/properties");
const markets_1 = require("./routes/markets");
const listings_1 = require("./routes/listings");
const prisma_1 = require("./prisma");
const health_1 = require("./routes/health");
const docs_1 = require("./routes/docs");
async function bootstrap() {
    const app = (0, fastify_1.default)({ logger: true });
    // CORS: accepter une liste d'origines
    await app.register(cors_1.default, {
        credentials: true,
        origin: (origin, cb) => {
            // autoriser requêtes serveur-à-serveur et outils (origin nul)
            if (!origin)
                return cb(null, true);
            if (env_1.env.CLIENT_ORIGINS.includes(origin))
                return cb(null, true);
            // autoriser tous les déploiements Vercel en preview
            if (/\.vercel\.app$/.test(origin))
                return cb(null, true);
            // autoriser localhost en dev
            if (origin.startsWith("http://localhost:"))
                return cb(null, true);
            cb(new Error("Origin not allowed"), false);
        },
    });
    // Helmet désactivé temporairement (incompatibilité de version avec Fastify v4). À réactiver après MAJ des versions.
    await app.register(rate_limit_1.default, { max: 100, timeWindow: '1 minute' });
    await app.register(cookie_1.default);
    app.decorate("prisma", prisma_1.prisma);
    // Auth invité par cookie: attribuer un UUID si absent
    app.addHook("onRequest", async (request, reply) => {
        const COOKIE_NAME = "hm_guest";
        const existing = request.cookies?.[COOKIE_NAME];
        if (!existing) {
            // Utilise nanoid pour générer un identifiant stable côté client
            const { nanoid } = await Promise.resolve().then(() => __importStar(require("nanoid")));
            const id = nanoid();
            reply.setCookie(COOKIE_NAME, id, {
                path: "/",
                httpOnly: true,
                sameSite: "lax",
                maxAge: 60 * 60 * 24 * 365, // 1 an
            });
        }
    });
    // Gestionnaire d'erreurs standardisé (Zod -> 400)
    app.setErrorHandler((err, req, reply) => {
        const isZod = err?.issues && err?.name === 'ZodError';
        if (isZod) {
            return reply.status(400).send({ error: 'Validation error', details: err.issues });
        }
        req.log.error({ err }, 'Unhandled error');
        return reply.status(500).send({ error: 'Internal Server Error' });
    });
    // Routes REST
    await (0, games_1.registerGameRoutes)(app);
    await (0, properties_1.registerPropertyRoutes)(app);
    await (0, markets_1.registerMarketRoutes)(app);
    await (0, listings_1.registerListingRoutes)(app);
    await (0, health_1.registerHealthRoutes)(app);
    try {
        await (0, docs_1.registerDocs)(app);
    }
    catch (e) {
        app.log.warn({ err: e }, "Swagger non chargé — démarrage sans /docs");
    }
    // Socket.IO attaché au server HTTP
    const { io, emitLeaderboard } = (0, socket_1.setupSocket)(app.server);
    app.decorate("io", io);
    app.addHook("onClose", async () => {
        await prisma_1.prisma.$disconnect();
        io.close();
    });
    // Cron horaire
    node_cron_1.default.schedule(env_1.env.CRON_TICK, async () => {
        app.log.info("[cron] hourlyTick");
        // pour chaque partie en cours
        const games = await prisma_1.prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
        for (const g of games) {
            await (0, simulation_1.hourlyTick)(g.id);
            // émettre classement rudimentaire
            const players = await prisma_1.prisma.player.findMany({
                where: { gameId: g.id },
                orderBy: { netWorth: "desc" },
                select: { id: true, nickname: true, netWorth: true },
            });
            emitLeaderboard(g.id, players.map((p) => ({
                playerId: p.id,
                nickname: p.nickname,
                netWorth: p.netWorth,
            })));
            // Mode sans fin: pas de condition de fin, la partie continue indéfiniment.
        }
    }, { timezone: env_1.env.TIMEZONE });
    // Cron annuel (toutes les 52 heures réelles) — approximé ici: toutes les 52 exécutions
    let hourCounter = 0;
    node_cron_1.default.schedule(env_1.env.CRON_TICK, async () => {
        hourCounter++;
        if (hourCounter % 52 === 0) {
            app.log.info("[cron] annualUpdate");
            const games = await prisma_1.prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
            for (const g of games)
                await (0, simulation_1.annualUpdate)(g.id);
        }
    }, { timezone: env_1.env.TIMEZONE });
    // Rafraîchissement nocturne (03:00 timezone locale)
    node_cron_1.default.schedule("0 3 * * *", async () => {
        app.log.info("[cron] nightlyRefresh");
        const games = await prisma_1.prisma.game.findMany({ where: { status: "running" } }).catch(() => []);
        for (const g of games)
            await (0, simulation_1.nightlyRefresh)(g.id);
    }, { timezone: env_1.env.TIMEZONE });
    await app.listen({ port: env_1.env.PORT, host: "0.0.0.0" });
}
bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
});
