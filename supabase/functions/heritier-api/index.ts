import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCore } from "./core.ts";
import { handleExtras } from "./extras.ts";
import { handleQuiz } from "./quiz.ts";
import {
  ApiError,
  authenticate,
  corsHeaders,
  json,
  normalizePath,
  sql,
  SUPABASE_URL,
} from "./lib.ts";

function isPublic(path: string): boolean {
  return path === "/health" || path === "/healthz" || path === "/api/auth/csrf" ||
    path === "/api/quiz/public-stats" || path === "/api/properties/templates" ||
    /^\/api\/properties\/templates\/[0-9a-fA-F-]{36}$/.test(path);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const path = normalizePath(url);

  try {
    if ((path === "/health" || path === "/healthz") && req.method === "GET") {
      const check = await sql`select 1 as ok`;
      return json({ ok: check[0]?.ok === 1, service: "heritier-api", backend: "supabase", at: new Date().toISOString() });
    }
    if (path === "/api/auth/csrf" && req.method === "GET") return json({ csrf: null, provider: "supabase-auth" });

    const user = isPublic(path) ? null : await authenticate(req);

    if (path === "/api/auth/me" && req.method === "GET") {
      return json({ id: user!.id, email: user!.email, isAdmin: user!.isAdmin });
    }
    if (path === "/api/auth/debug-token" && req.method === "GET") {
      return json({ authenticated: true, userId: user!.id, email: user!.email, provider: "supabase-auth" });
    }
    if (path === "/api/auth/logout" && req.method === "POST") return json({ ok: true });

    if (path === "/api/auth/delete-account" && req.method === "POST") {
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!serviceKey) throw new ApiError(503, "Suppression de compte temporairement indisponible");
      const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user!.id}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
      });
      if (!response.ok) throw new ApiError(502, "Le compte n’a pas pu être supprimé");
      return json({ deleted: true });
    }

    const handlers = [handleCore, handleQuiz, handleExtras];
    for (const handler of handlers) {
      const response = await handler(req, url, path, user);
      if (response) return response;
    }

    throw new ApiError(404, "Route introuvable");
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message, ...(error.details && typeof error.details === "object" ? error.details : {}) }, error.status);
    }
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (code === "23505") return json({ error: "Cette opération existe déjà ou entre en conflit avec une autre." }, 409);
    if (code === "23503") return json({ error: "Une donnée liée est introuvable." }, 409);
    if (code === "22P02") return json({ error: "Identifiant invalide." }, 400);
    console.error("[heritier-api]", error instanceof Error ? error.message : String(error));
    return json({ error: "Erreur interne. Réessayez dans un instant." }, 500);
  }
});
