import { ApiError, type AuthUser, body, fail, json, playerFor, sql } from "./lib.ts";
import { getAdmobKeys, verifyAdmobCallback } from "./admob-ssv.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(["quiz-token", "pari-token", "quiz-reveal", "bonus"]);
function units(): Set<string> {
  const values = (Deno.env.get("ADMOB_REWARDED_AD_UNIT_IDS") ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (!values.length) throw new ApiError(503, "Les récompenses publicitaires sont temporairement indisponibles");
  return new Set(values);
}

export async function consumeRewardIntent(tx: any, id: unknown, playerId: string, kind: string, context: Record<string, string> = {}): Promise<void> {
  fail(typeof id === "string" && UUID.test(id), 403, "Une publicité vérifiée est requise");
  // Updating in the reward's transaction guarantees one use, including concurrent retries.
  const consumed = await tx`
    update heritier.reward_intents set consumed_at=now()
    where id=${id}::uuid and player_id=${playerId}::uuid and kind=${kind}
      and context=${JSON.stringify(context)}::jsonb and verified_at is not null
      and consumed_at is null and expires_at > now()
    returning id
  `;
  fail(consumed[0], 409, "Publicité en attente de vérification, expirée ou déjà utilisée");
}

export async function handleRewards(req: Request, url: URL, path: string, user: AuthUser | null): Promise<Response | null> {
  if (path === "/api/ads/admob/ssv" && req.method === "GET") {
    const verified = await verifyAdmobCallback(url, units(), await getAdmobKeys());
    const rows = await sql`
      update heritier.reward_intents r set verified_at=coalesce(r.verified_at, now()), ad_transaction_id=${verified.transactionId}
      from heritier.players p
      where r.id=${verified.intentId}::uuid and p.id=r.player_id and p.auth_user_id=${verified.userId}::uuid
        and (r.ad_transaction_id is null or r.ad_transaction_id=${verified.transactionId})
        and to_timestamp(${verified.timestamp}::double precision/1000) >= r.created_at - interval '1 minute'
        and to_timestamp(${verified.timestamp}::double precision/1000) <= least(r.expires_at, now() + interval '1 minute')
        and (r.expires_at > now() or r.ad_transaction_id=${verified.transactionId})
      returning r.id
    `;
    fail(rows[0], 400, "Notification publicitaire invalide ou expirée");
    return json({ ok: true });
  }

  const match = path.match(/^\/api\/games\/([0-9a-f-]{36})\/rewards\/intents(?:\/([0-9a-f-]{36}))?$/i);
  if (!match) return null;
  fail(user, 401, "Connexion requise");
  const player = await playerFor(user, match[1], req.headers.get("x-player-id"));
  if (req.method === "POST" && !match[2]) {
    units(); // Fail before showing an ad if SSV has not been configured.
    const payload = await body(req), kind = String(payload.kind ?? "");
    fail(KINDS.has(kind), 400, "Type de récompense invalide");
    const context: Record<string, string> = {};
    if (kind === "quiz-reveal") {
      fail(typeof payload.sessionId === "string" && UUID.test(payload.sessionId) && typeof payload.questionId === "string" && UUID.test(payload.questionId), 400, "Session ou question invalide");
      context.sessionId = payload.sessionId; context.questionId = payload.questionId;
    }
    const intent = await sql.begin(async (tx: any) => {
      await tx`select id from heritier.players where id=${player.id}::uuid for update`;
      const counts = await tx`select count(*)::integer as count from heritier.reward_intents where player_id=${player.id}::uuid and created_at > now() - interval '1 hour'`;
      fail(Number(counts[0].count) < 30, 429, "Trop de demandes publicitaires. Réessayez plus tard.");
      if (kind === "quiz-reveal") {
        const active = await tx`select id from heritier.quiz_sessions where id=${context.sessionId}::uuid and player_id=${player.id}::uuid and game_id=${match[1]}::uuid and status='active' and current_question_id=${context.questionId}::uuid`;
        fail(active[0], 409, "Cette question n’est plus active");
      }
      return (await tx`insert into heritier.reward_intents(player_id,game_id,kind,context) values(${player.id}::uuid,${match[1]}::uuid,${kind},${JSON.stringify(context)}::jsonb) returning id,expires_at`)[0];
    });
    return json({ id: intent.id, userId: user.id, expiresAt: intent.expires_at }, 201);
  }
  if (req.method === "GET" && match[2]) {
    const rows = await sql`select verified_at,consumed_at,expires_at from heritier.reward_intents where id=${match[2]}::uuid and player_id=${player.id}::uuid and game_id=${match[1]}::uuid`;
    fail(rows[0], 404, "Publicité introuvable");
    const expired = new Date(rows[0].expires_at).getTime() <= Date.now();
    return json({ verified: Boolean(rows[0].verified_at), consumed: Boolean(rows[0].consumed_at), expired });
  }
  return null;
}
