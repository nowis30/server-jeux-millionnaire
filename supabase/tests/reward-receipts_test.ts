import assert from "node:assert/strict";
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
Deno.env.set("SUPABASE_DB_URL", "postgres://unused:unused@127.0.0.1:1/unused");
const { consumeRewardIntent } = await import("../functions/heritier-api/rewards.ts");

Deno.test("real PostgreSQL receipt migration, ownership, purpose, expiry, rollback and single use", async () => {
  const db = new PGlite();
  try {
    await db.exec("create schema heritier; create role anon; create role authenticated; create table heritier.games(id uuid primary key); create table heritier.players(id uuid primary key);");
    const migration = await Deno.readTextFile(new URL("../migrations/20261026153014_heritier_reward_verification.sql", import.meta.url));
    await db.exec(migration);
    await db.exec(migration); // Re-running cannot expose or drop receipts.
    const player = "11111111-1111-4111-8111-111111111111", game = "22222222-2222-4222-8222-222222222222";
    await db.query("insert into heritier.players values ($1)", [player]);
    await db.query("insert into heritier.games values ($1)", [game]);
    const result = await db.query<{id:string}>("insert into heritier.reward_intents(player_id,game_id,kind) values ($1,$2,'bonus') returning id", [player,game]);
    const id = result.rows[0].id;
    const tag = (connection: {query: (...args: any[]) => any}) => async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.reduce((text, fragment, index) => text + fragment + (index < values.length ? `$${index + 1}` : ''), '');
      return (await connection.query(statement, values)).rows;
    };
    await assert.rejects(consumeRewardIntent(tag(db), id, player, 'bonus'), /en attente/);
    await db.query("update heritier.reward_intents set verified_at=now(),ad_transaction_id='one-ad' where id=$1", [id]);
    await assert.rejects(consumeRewardIntent(tag(db), id, game, 'bonus'), /en attente/);
    await assert.rejects(consumeRewardIntent(tag(db), id, player, 'pari-token'), /en attente/);
    await assert.rejects(consumeRewardIntent(tag(db), id, player, 'bonus', { sessionId: game }), /en attente/);
    await assert.rejects(db.transaction(async tx => { await consumeRewardIntent(tag(tx), id, player, 'bonus'); throw new Error('reward failed'); }), /reward failed/);
    const attempts = await Promise.allSettled([consumeRewardIntent(tag(db), id, player, 'bonus'), consumeRewardIntent(tag(db), id, player, 'bonus')]);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    await assert.rejects(consumeRewardIntent(tag(db), id, player, 'bonus'), /en attente/);
    await assert.rejects(db.query("insert into heritier.reward_intents(player_id,game_id,kind,verified_at,ad_transaction_id) values ($1,$2,'bonus',now(),'one-ad')", [player,game]), /unique/);
    const expired = await db.query<{id:string}>("insert into heritier.reward_intents(player_id,game_id,kind,verified_at,ad_transaction_id,expires_at) values ($1,$2,'bonus',now(),'expired-ad',now()-interval '1 minute') returning id", [player,game]);
    await assert.rejects(consumeRewardIntent(tag(db), expired.rows[0].id, player, 'bonus'), /en attente/);
    const policy = await db.query<{rls:boolean,readable:boolean}>("select relrowsecurity as rls, has_table_privilege('authenticated','heritier.reward_intents','SELECT') as readable from pg_class where oid='heritier.reward_intents'::regclass");
    assert.equal(policy.rows[0].rls, true); assert.equal(policy.rows[0].readable, false);
  } finally { await db.close(); }
});
