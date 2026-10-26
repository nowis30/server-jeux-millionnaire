import assert from "node:assert/strict";
import { readJsonBody, MAX_BODY_BYTES } from "../functions/heritier-api/request-body.ts";
import { ApiError } from "../functions/heritier-api/errors.ts";

function request(body: string, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Request("https://example.test/api", { method: "POST", headers, body });
}
Deno.test("JSON object is parsed without coercion", async () => {
  assert.deepEqual(await readJsonBody(request('{"value":0,"valid":false}')), { value: 0, valid: false });
});
for (const value of ['null', '[]', '"string"', '{']) {
  Deno.test(`reject invalid JSON object ${value}`, async () => {
    await assert.rejects(readJsonBody(request(value)), (e: unknown) => e instanceof ApiError && e.status === 400);
  });
}
Deno.test("reject unsupported content type", async () => {
  await assert.rejects(readJsonBody(request('{}', { 'content-type': 'text/plain' })), (e: unknown) => e instanceof ApiError && e.status === 415);
});
Deno.test("enforce byte limit even with a missing or dishonest Content-Length", async () => {
  for (const length of [undefined, "1", String(MAX_BODY_BYTES + 1)]) {
    const headers: Record<string,string> = { "content-type": "application/json" };
    if (length) headers["content-length"] = length;
    await assert.rejects(readJsonBody(request(JSON.stringify({ data: "é".repeat(MAX_BODY_BYTES) }), headers)), (e: unknown) => e instanceof ApiError && e.status === 413);
  }
});
Deno.test("empty request without a body remains compatible", async () => {
  assert.deepEqual(await readJsonBody(new Request("https://example.test")), {});
});
