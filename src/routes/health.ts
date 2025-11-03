import { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/healthz", async (_req, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: "ok" });
    } catch (err) {
      app.log.error({ err }, "healthcheck failed");
      return reply.status(503).send({ status: "degraded" });
    }
  });
}
