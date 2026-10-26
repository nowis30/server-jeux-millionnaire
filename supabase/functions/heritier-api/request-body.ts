import { ApiError } from "./errors.ts";

export const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) return {};
  const type = (req.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new ApiError(415, "Un corps JSON est requis");
  const advertised = req.headers.get("content-length");
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BODY_BYTES)) {
    throw new ApiError(413, "Requête trop volumineuse");
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "Requête trop volumineuse");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new ApiError(400, "Corps JSON invalide");
  }
}
