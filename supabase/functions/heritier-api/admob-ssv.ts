import { ApiError } from "./errors.ts";

export type AdmobKey = { keyId: number; base64: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
let cache: { expires: number; keys: AdmobKey[] } | undefined;
let loading: Promise<AdmobKey[]> | undefined;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  } catch { throw new ApiError(400, "Signature publicitaire invalide"); }
}

// Google sends DER ECDSA; WebCrypto expects the fixed-width P1363 representation.
function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) throw new ApiError(400, "Signature publicitaire invalide");
  const raw = new Uint8Array(64);
  let offset = 2;
  for (let part = 0; part < 2; part++) {
    if (der[offset++] !== 0x02) throw new ApiError(400, "Signature publicitaire invalide");
    const length = der[offset++];
    if (!length || length > 33 || offset + length > der.length || der[offset] & 0x80) throw new ApiError(400, "Signature publicitaire invalide");
    let integer = der.subarray(offset, offset + length);
    if (integer[0] === 0 && integer.length > 1) {
      if (!(integer[1] & 0x80)) throw new ApiError(400, "Signature publicitaire invalide");
      integer = integer.subarray(1);
    }
    if (integer.length > 32) throw new ApiError(400, "Signature publicitaire invalide");
    raw.set(integer, part * 32 + 32 - integer.length);
    offset += length;
  }
  if (offset !== der.length) throw new ApiError(400, "Signature publicitaire invalide");
  return raw;
}

export async function getAdmobKeys(): Promise<AdmobKey[]> {
  if (cache && cache.expires > Date.now()) return cache.keys;
  if (!loading) loading = (async () => {
    const response = await fetch(KEY_URL, { signal: AbortSignal.timeout(5_000), redirect: "error" });
    if (!response.ok) throw new ApiError(503, "Vérification publicitaire temporairement indisponible");
    const raw = await response.text();
    if (raw.length > 64_000) throw new ApiError(503, "Réponse de vérification invalide");
    const data = JSON.parse(raw) as { keys?: AdmobKey[] };
    if (!Array.isArray(data.keys) || !data.keys.length || data.keys.some(k => !Number.isSafeInteger(k.keyId) || typeof k.base64 !== "string")) throw new ApiError(503, "Clés de vérification indisponibles");
    cache = { keys: data.keys, expires: Date.now() + 6 * 60 * 60 * 1000 };
    return data.keys;
  })().finally(() => { loading = undefined; });
  return loading;
}

export async function verifyAdmobCallback(url: URL, allowedUnits: Set<string>, keys: AdmobKey[]) {
  const raw = url.search.slice(1);
  if (raw.length > 8192) throw new ApiError(400, "Notification publicitaire invalide");
  // Match Google's reference verifier (URI.getQuery): percent-decode once,
  // preserving parameter order and literal plus signs. Do not reserialize parameters.
  let signedQuery: string;
  try { signedQuery = decodeURIComponent(raw); }
  catch { throw new ApiError(400, "Notification publicitaire invalide"); }
  const match = signedQuery.match(/^(.*)&signature=([^&]+)&key_id=(\d+)$/);
  const p = url.searchParams;
  const names = [...p.keys()];
  // The reference signature covers a decoded query. Reject decoded delimiters
  // inside fields so signature verification and field parsing share boundaries.
  const ambiguous = [...p].some(([name, value]) => !/^[a-z][a-z0-9_]*$/i.test(name) || value.includes("&"));
  if (!match || ambiguous || new Set(names).size !== names.length) throw new ApiError(400, "Notification publicitaire invalide");
  const intentId = p.get("custom_data") ?? "", userId = p.get("user_id") ?? "";
  const transactionId = p.get("transaction_id") ?? "", unit = p.get("ad_unit") ?? "";
  const timestamp = Number(p.get("timestamp"));
  if (!UUID.test(intentId) || !UUID.test(userId) || !/^[a-zA-Z0-9_-]{8,200}$/.test(transactionId) ||
      !allowedUnits.has(unit) || !Number.isSafeInteger(timestamp) || timestamp <= 0 ||
      !Number.isFinite(Number(p.get("reward_amount"))) || Number(p.get("reward_amount")) <= 0) {
    throw new ApiError(400, "Notification publicitaire invalide");
  }
  const key = keys.find(k => String(k.keyId) === match[3]);
  if (!key) throw new ApiError(403, "Clé de signature inconnue");
  const publicKey = await crypto.subtle.importKey("spki", decodeBase64(key.base64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
    derToRaw(decodeBase64(p.get("signature") ?? "")), new TextEncoder().encode(match[1]));
  if (!verified) throw new ApiError(403, "Signature publicitaire invalide");
  return { intentId, userId, transactionId, timestamp };
}
