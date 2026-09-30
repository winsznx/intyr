import type { Context } from "hono";

/** Largest request body any paid route accepts. A five-component trip intent is about 1 KiB. */
export const BODY_LIMIT_BYTES = 64 * 1024;

export type BodyRead = { ok: true; raw: string } | { ok: false; response: Response };

function tooLarge(): Response {
  return Response.json(
    { error: "PAYLOAD_TOO_LARGE", message: `Request bodies are limited to ${BODY_LIMIT_BYTES} bytes.`, limit_bytes: BODY_LIMIT_BYTES, charged: false },
    { status: 413 },
  );
}

/**
 * Reads a request body up to the limit without buffering more than that, so an oversized or endless upload is
 * refused before any payment is decoded or any work starts.
 */
export async function readBodyWithLimit(c: Context, limit = BODY_LIMIT_BYTES): Promise<BodyRead> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return { ok: false, response: tooLarge() };
  const stream = c.req.raw.body;
  if (!stream) return { ok: true, raw: "" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { ok: false, response: tooLarge() };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, raw: new TextDecoder().decode(bytes) };
}
