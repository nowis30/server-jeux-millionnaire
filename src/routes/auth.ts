import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import bcrypt from "bcryptjs";
import { env } from "../env";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function registerAuthRoutes(app: FastifyInstance) {
  // JWT plugin
  if (!app.hasDecorator("jwt" as any)) {
    await app.register(require("@fastify/jwt"), { secret: env.JWT_SECRET });
  }

  // register
  app.post("/api/auth/register", async (req, reply) => {
    const { email, password } = RegisterSchema.parse((req as any).body ?? {});
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.status(409).send({ error: "Email déjà utilisé" });
    const passwordHash = await bcrypt.hash(password, 10);
  const isAdmin = !!env.ADMIN_EMAIL && email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
    const user = await prisma.user.create({ data: { email, passwordHash, isAdmin } });
    const token = (app as any).jwt.sign({ sub: user.id, email: user.email, isAdmin: user.isAdmin }, { expiresIn: "12h" });
    // Auth cookie cross-site: SameSite=None; Secure (session cookie: pas de maxAge)
    reply.setCookie("hm_auth", token, { path: "/", httpOnly: true, sameSite: "none", secure: true });
    // CSRF cookie (non httpOnly)
    const csrf = Math.random().toString(36).slice(2);
    reply.setCookie("hm_csrf", csrf, { path: "/", httpOnly: false, sameSite: "none", secure: true });
    return reply.send({ id: user.id, email: user.email, isAdmin: user.isAdmin });
  });

  // login
  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = LoginSchema.parse((req as any).body ?? {});
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.status(401).send({ error: "Identifiants invalides" });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return reply.status(401).send({ error: "Identifiants invalides" });
    const token = (app as any).jwt.sign({ sub: user.id, email: user.email, isAdmin: user.isAdmin }, { expiresIn: "12h" });
    reply.setCookie("hm_auth", token, { path: "/", httpOnly: true, sameSite: "none", secure: true });
    // rafraîchir CSRF
    const csrf = Math.random().toString(36).slice(2);
    reply.setCookie("hm_csrf", csrf, { path: "/", httpOnly: false, sameSite: "none", secure: true });
    return reply.send({ id: user.id, email: user.email, isAdmin: user.isAdmin });
  });

  // me
  app.get("/api/auth/me", async (req, reply) => {
    try {
      const token = (req as any).cookies?.["hm_auth"];
      if (!token) return reply.status(401).send({ error: "Unauthenticated" });
      const payload = (app as any).jwt.verify(token) as { sub: string; email: string; isAdmin: boolean; iat?: number };
      // Barrière anti-tokens anciens (même sans exp) : max 12h
      const nowSec = Math.floor(Date.now() / 1000);
      const iat = payload.iat ?? 0;
      const maxAgeSec = 12 * 60 * 60;
      if (!iat || (nowSec - iat) > maxAgeSec) {
        return reply.status(401).send({ error: "Unauthenticated" });
      }
      return reply.send({ id: payload.sub, email: payload.email, isAdmin: payload.isAdmin });
    } catch (e) {
      return reply.status(401).send({ error: "Unauthenticated" });
    }
  });

  // logout
  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie("hm_auth", { path: "/" });
    reply.clearCookie("hm_csrf", { path: "/" });
    return reply.send({ ok: true });
  });
}

export function requireAdmin(app: FastifyInstance) {
  return async function (req: any, reply: any) {
    try {
      const token = req.cookies?.["hm_auth"];
      if (!token) return reply.status(401).send({ error: "Unauthenticated" });
      const payload = (app as any).jwt.verify(token) as { sub: string; email: string; isAdmin: boolean };
      if (!payload.isAdmin) return reply.status(403).send({ error: "Forbidden" });
      (req as any).user = payload;
    } catch (e) {
      return reply.status(401).send({ error: "Unauthenticated" });
    }
  };
}
