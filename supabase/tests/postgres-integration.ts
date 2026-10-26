import assert from "node:assert/strict";
import postgres from "npm:postgres@3.4.7";
import { generateKeyPairSync, sign } from "node:crypto";

const url = Deno.env.get("TEST_DATABASE_URL");
if (!url) throw new Error("TEST_DATABASE_URL is required for the isolated integration database");
const target = new URL(url);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/heritier_security_test") {
  throw new Error("Only the disposable local heritier_security_test database is allowed");
}
Deno.env.set("SUPABASE_DB_URL", url);
Deno.env.set("ADMOB_REWARDED_AD_UNIT_IDS", "3604239096");
const db = postgres(url, { max: 2, onnotice: () => {} });
const { sql } = await import("../functions/heritier-api/lib.ts");
const { handleQuiz } = await import("../functions/heritier-api/quiz.ts");
const { handleExtras } = await import("../functions/heritier-api/extras.ts");
const { handleRewards } = await import("../functions/heritier-api/rewards.ts");

Deno.test("PostgreSQL handlers: migrations, simultaneous quiz starts, signed callback and one reward", async () => {
  const originalFetch = globalThis.fetch;
  let initialized = false;
  try {
    const existing = await db`select 1 from pg_namespace where nspname in ('heritier','auth')`;
    assert.equal(existing.length, 0, "The integration database must be empty; no existing data is modified");
    await db.unsafe("create schema auth; create table auth.users(id uuid primary key,email text);");
    initialized = true;
    await db.unsafe("do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;");
    // pg_cron scheduling is a hosted integration; test every schema statement before it.
    const files = [...Deno.readDirSync(new URL('../migrations/', import.meta.url))].map(f => f.name).filter(n => n.endsWith('.sql')).sort();
    for (const file of files) {
      let migration = await Deno.readTextFile(new URL(`../migrations/${file}`, import.meta.url));
      migration = migration.split('create extension if not exists pg_cron;')[0];
      await db.unsafe(migration);
    }
    const actor = { id: crypto.randomUUID(), email: 'integration@example.test', isAdmin: false, accessToken: 'test-only' };
    const game = crypto.randomUUID(), player = crypto.randomUUID();
    await db`insert into auth.users(id,email) values(${actor.id}::uuid,${actor.email})`;
    await db`insert into heritier.games(id,code) values(${game}::uuid,'SECURITY_TEST')`;
    await db`insert into heritier.players(id,game_id,auth_user_id,nickname) values(${player}::uuid,${game}::uuid,${actor.id}::uuid,'Integration')`;
    const request = (path: string, payload: unknown) => new Request(`https://example.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-player-id': player }, body: JSON.stringify(payload) });
    const startPath = `/api/games/${game}/quiz/start`;
    const starts = await Promise.all(Array.from({length: 8}, async () => {
      const req = request(startPath, {});
      const response = await handleQuiz(req, new URL(req.url), startPath, actor);
      return await response!.json();
    }));
    assert.equal(new Set(starts.map(s => s.sessionId)).size, 1);
    assert.equal(Number((await db`select quiz_tokens from heritier.players where id=${player}::uuid`)[0].quiz_tokens), 14);
    const sessionId = starts[0].sessionId, questionId = starts[0].question.id;
    const revealPath = `/api/games/${game}/quiz/reveal`;
    await assert.rejects(handleQuiz(request(revealPath, {sessionId,questionId}), new URL(`https://example.test${revealPath}`), revealPath, actor), /publicité vérifiée/);
    const intentPath = `/api/games/${game}/rewards/intents`;
    const response = await handleRewards(request(intentPath, {kind: 'bonus'}), new URL(`https://example.test${intentPath}`), intentPath, actor);
    const intent = await response!.json();
    const pair = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
    const publicKey = pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://www.gstatic.com/admob/reward/verifier-keys.json') return Promise.resolve(Response.json({keys:[{keyId:42,base64:publicKey}]}));
      return originalFetch(input,init);
    }) as typeof fetch;
    const query = `ad_network=123&ad_unit=3604239096&custom_data=${intent.id}&reward_amount=1&reward_item=coins&timestamp=${Date.now()}&transaction_id=0123456789abcdef&user_id=${actor.id}`;
    const signature = sign('sha256',Buffer.from(query),pair.privateKey).toString('base64url');
    const callback = new URL(`https://example.test/api/ads/admob/ssv?${query}&signature=${signature}&key_id=42`);
    for (let attempt=0;attempt<2;attempt++) assert.equal((await handleRewards(new Request(callback),callback,callback.pathname,null))!.status,200);
    const bonusPath = `/api/games/${game}/bonus/redeem`;
    const claims = await Promise.allSettled(Array.from({length: 2}, () => handleExtras(request(bonusPath,{rewardIntentId:intent.id}),new URL(`https://example.test${bonusPath}`),bonusPath,actor)));
    assert.equal(claims.filter(r => r.status==='fulfilled').length,1);
    assert.equal(Number((await db`select cash from heritier.players where id=${player}::uuid`)[0].cash),2_000_000);
    assert.equal((await db`select consumed_at from heritier.reward_intents where id=${intent.id}::uuid`)[0].consumed_at instanceof Date,true);
  } finally {
    globalThis.fetch=originalFetch;
    await sql.end();
    if (initialized) await db.unsafe('drop schema if exists heritier cascade; drop schema auth cascade;');
    await db.end();
  }
});
