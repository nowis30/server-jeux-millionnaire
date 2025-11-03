import { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import path from "path";

export async function registerDocs(app: FastifyInstance) {
  const specPath = "openapi/openapi.yaml";
  await app.register(swagger, {
    mode: "static",
    specification: {
      path: specPath,
      baseDir: process.cwd(),
    },
  });
  await app.register(swaggerUI, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });
}
