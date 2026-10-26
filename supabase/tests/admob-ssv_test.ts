import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyAdmobCallback } from "../functions/heritier-api/admob-ssv.ts";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keys = [{ keyId: 42, base64: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") }];
const intentId = "11111111-1111-4111-8111-111111111111", userId = "22222222-2222-4222-8222-222222222222";
const query = `ad_network=123&ad_unit=3604239096&custom_data=${intentId}&reward_amount=1&reward_item=coins&timestamp=1793028600000&transaction_id=0123456789abcdef&user_id=${userId}`;
function signed(value: string) {
  const signature = sign("sha256", Buffer.from(decodeURIComponent(value)), pair.privateKey).toString("base64url");
  return new URL(`https://example.test/api/ads/admob/ssv?${value}&signature=${signature}&key_id=42`);
}
Deno.test("verify genuine P-256 DER signature and bound reward identity", async () => {
  assert.deepEqual(await verifyAdmobCallback(signed(query), new Set(["3604239096"]), keys), { intentId, userId, transactionId: "0123456789abcdef", timestamp: 1793028600000 });
});
for (const [label, change] of [
  ["forged amount", (u: URL) => { u.searchParams.set("reward_amount", "1000000"); }],
  ["another user", (u: URL) => { u.searchParams.set("user_id", intentId); }],
  ["duplicate parameter", (u: URL) => { u.search = u.search.replace('&signature=', '&ad_unit=3604239096&signature='); }],
  ["missing signature", (u: URL) => { u.searchParams.delete("signature"); }],
  ["unknown key", (u: URL) => { u.searchParams.set("key_id", "999"); }],
  ["malformed DER", (u: URL) => { u.searchParams.set("signature", "AAAA"); }],
] as const) {
  Deno.test(`reject ${label}`, async () => {
    const url = signed(query); change(url);
    await assert.rejects(verifyAdmobCallback(url, new Set(["3604239096"]), keys));
  });
}
Deno.test("reject validly signed callback for an unauthorized ad unit", async () => {
  await assert.rejects(verifyAdmobCallback(signed(query), new Set(["other-unit"]), keys));
});
Deno.test("no timestamp or no custom data cannot become a verified receipt", async () => {
  for (const invalid of [query.replace(/timestamp=\d+/, 'timestamp=NaN'), query.replace(`custom_data=${intentId}`, 'custom_data=attacker')])
    await assert.rejects(verifyAdmobCallback(signed(invalid), new Set(["3604239096"]), keys));
});

Deno.test("percent-escaped values use the reference verifier's decoded query", async () => {
  const callback = signed(query.replace('reward_item=coins', 'reward_item=virtual%20coins%2Bbonus'));
  assert.equal((await verifyAdmobCallback(callback, new Set(["3604239096"]), keys)).intentId, intentId);
});

for (const [label, invalid] of [
  ["delimiter inside a decoded value", query.replace('reward_item=coins', 'reward_item=coins%26bonus')],
  ["equals sign inside a parameter name", query.replace('reward_item=', 'reward%3Ditem=')],
  ["delimiter inside a parameter name", query.replace('reward_item=', 'reward%26item=')],
] as const) {
  Deno.test(`reject ambiguous input: ${label}`, async () => {
    await assert.rejects(verifyAdmobCallback(signed(invalid), new Set(["3604239096"]), keys), { status: 400 });
  });
}
