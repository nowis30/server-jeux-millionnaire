import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import bcrypt from "bcryptjs";
import { env } from "../env";
import { nanoid } from "nanoid";
import { sendMail } from "../services/mailer";

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
  const user = await (prisma as any).user.create({ data: { email, passwordHash, isAdmin, emailVerified: false } });
    // Envoyer un email de vérification
    try {
      const token = nanoid();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24h
      await (prisma as any).emailVerificationToken.create({ data: { userId: user.id, token, expiresAt } });
      const link = `${env.APP_ORIGIN.replace(/\/$/, "")}/verify?token=${encodeURIComponent(token)}`;
      await sendMail({
        to: email,
        subject: "Vérifiez votre adresse email",
        html: `<p>Bienvenue!</p><p>Pour activer votre compte, cliquez sur le lien suivant (valide 24h):</p><p><a href="${link}">${link}</a></p>`,
      });
    } catch (e) {
      app.log.warn({ err: e }, "Envoi email de vérification échoué");
    }
    // Pas d'auth tant que non vérifié
    return reply.send({ ok: true, message: "Compte créé. Vérifiez votre email pour activer le compte." });
  });

  // login
  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = LoginSchema.parse((req as any).body ?? {});
  const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.status(401).send({ error: "Identifiants invalides" });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return reply.status(401).send({ error: "Identifiants invalides" });
    if (!(user as any).emailVerified) {
      return reply.status(403).send({ error: "Email non vérifié. Consultez votre boîte de réception ou demandez un nouvel email de vérification." });
    }
    const token = (app as any).jwt.sign({ sub: user.id, email: user.email, isAdmin: user.isAdmin }, { expiresIn: "12h" });
    reply.setCookie("hm_auth", token, { path: "/", httpOnly: true, sameSite: "none", secure: true });
    // rafraîchir CSRF
    const csrf = Math.random().toString(36).slice(2);
    reply.setCookie("hm_csrf", csrf, { path: "/", httpOnly: false, sameSite: "none", secure: true });
    return reply.send({ id: user.id, email: user.email, isAdmin: user.isAdmin, token });
  });

  // Vérifier email (via token)
  app.get("/api/auth/verify-email", async (req, reply) => {
    const token = String(((req as any).query?.token ?? "")).trim();
    if (!token) return reply.status(400).send({ error: "Token manquant" });
    const rec = await (prisma as any).emailVerificationToken.findUnique({ where: { token } });
    if (!rec || rec.usedAt || new Date(rec.expiresAt) < new Date()) {
      return reply.status(400).send({ error: "Token invalide ou expiré" });
    }
    await prisma.$transaction([
      (prisma as any).user.update({ where: { id: rec.userId }, data: { emailVerified: true } }),
      (prisma as any).emailVerificationToken.update({ where: { token }, data: { usedAt: new Date() } }),
    ] as any);
    return reply.send({ ok: true });
  });

  // Renvoyer l'email de vérification
  app.post("/api/auth/resend-verification", async (req, reply) => {
    const body = (req as any).body ?? {};
    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return reply.status(400).send({ error: "Email requis" });
  const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.send({ ok: true });
  if ((user as any).emailVerified) return reply.send({ ok: true });
    const token = nanoid();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
    await (prisma as any).emailVerificationToken.create({ data: { userId: user.id, token, expiresAt } });
    const link = `${env.APP_ORIGIN.replace(/\/$/, "")}/verify?token=${encodeURIComponent(token)}`;
    await sendMail({ to: email, subject: "Vérifiez votre adresse email", html: `<p><a href="${link}">${link}</a></p>` });
    return reply.send({ ok: true });
  });

  // me
  app.get("/api/auth/me", async (req, reply) => {
    try {
      const authHeader = (req.headers?.["authorization"] as string) || "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      const tokenCookie = (req as any).cookies?.["hm_auth"];
      const token = bearer || tokenCookie;
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

  // CSRF token endpoint: renvoie un token utilisable côté client pour les requêtes cross-site
  // Stratégie: si cookie hm_csrf manquant, on le génère ici ET on renvoie la même valeur en JSON.
  // Le client lit le JSON et place la valeur dans l'entête x-csrf-token pour les requêtes POST/PUT/etc.
  app.get("/api/auth/csrf", async (req, reply) => {
    let token = (req as any).cookies?.["hm_csrf"] as string | undefined;
    if (!token) {
      token = nanoid();
      reply.setCookie("hm_csrf", token, {
        path: "/",
        httpOnly: false,
        sameSite: "none",
        secure: true,
      });
    }
    return reply.send({ csrf: token });
  });

  // Demander un reset de mot de passe (envoi d'email)
  app.post("/api/auth/request-reset", async (req, reply) => {
    const body = (req as any).body ?? {};
    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return reply.status(400).send({ error: "Email requis" });
    const user = await prisma.user.findUnique({ where: { email } });
    // Toujours répondre 200 pour ne pas révéler l'existence d'un compte
    if (!user) return reply.send({ ok: true });

    const token = nanoid();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30); // 30 min
    // Utiliser any pour compatibilité si Prisma Client non régénéré
    await (prisma as any).passwordResetToken.create({
      data: { userId: user.id, token, expiresAt },
    });
    const link = `${env.APP_ORIGIN.replace(/\/$/, "")}/reset?token=${encodeURIComponent(token)}`;
    await sendMail({
      to: email,
      subject: "Réinitialisation de votre mot de passe",
      html: `<p>Bonjour,</p><p>Pour réinitialiser votre mot de passe, cliquez sur le lien suivant (valide 30 minutes):</p><p><a href="${link}">${link}</a></p>`,
    });
    return reply.send({ ok: true });
  });

  // Effectuer le reset avec le token
  app.post("/api/auth/reset", async (req, reply) => {
    const body = (req as any).body ?? {};
    const token = String(body.token || "").trim();
    const newPassword = String(body.password || "");
    if (!token || newPassword.length < 6) return reply.status(400).send({ error: "Paramètres invalides" });
    const rec = await (prisma as any).passwordResetToken.findUnique({ where: { token } });
    if (!rec || rec.usedAt || new Date(rec.expiresAt) < new Date()) {
      return reply.status(400).send({ error: "Token invalide ou expiré" });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.$transaction([
      prisma.user.update({ where: { id: rec.userId }, data: { passwordHash: hash } }),
      (prisma as any).passwordResetToken.update({ where: { token }, data: { usedAt: new Date() } }),
    ] as any);
    return reply.send({ ok: true });
  });
}

export function requireAdmin(app: FastifyInstance) {
  return async function (req: any, reply: any) {
    try {
      const authHeader = (req.headers?.["authorization"] as string) || "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      const tokenCookie = req.cookies?.["hm_auth"];
      const raw = bearer || tokenCookie;
      if (!raw) return reply.status(401).send({ error: "Unauthenticated" });
      const payload = (app as any).jwt.verify(raw) as { sub: string; email: string; isAdmin: boolean };
      if (!payload.isAdmin) return reply.status(403).send({ error: "Forbidden" });
      (req as any).user = payload;
    } catch (e) {
      return reply.status(401).send({ error: "Unauthenticated" });
    }
  };
}

export function requireUser(app: FastifyInstance) {
  return async function (req: any, reply: any) {
    try {
      const authHeader = (req.headers?.["authorization"] as string) || "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      const tokenCookie = req.cookies?.["hm_auth"];
      const raw = bearer || tokenCookie;
      if (!raw) return reply.status(401).send({ error: "Unauthenticated" });
      const payload = (app as any).jwt.verify(raw) as { sub: string; email: string; isAdmin: boolean };
      (req as any).user = payload;
    } catch (e) {
      return reply.status(401).send({ error: "Unauthenticated" });
    }
  };
}
