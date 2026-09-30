import { describe, expect, it } from "vitest";
import {
  generateSigningKey,
  publishedKey,
  signDocument,
  signingKeyFromJwkJson,
  verify,
  verifyDocument,
  type Signed,
} from "../src/sign";
import { payloadHash } from "../src/sign";
import { NOW } from "./fixtures";

const PAYLOAD = { trip_id: "trp_1", total_minor: 40_000, legs: ["hotel", "flight"] };

async function fixture() {
  const key = await generateSigningKey("key-2026-10");
  return { key, keys: [publishedKey(key, NOW.toISOString())] };
}

describe("signDocument and verifyDocument", () => {
  it("verifies a document signed in the expected context", async () => {
    const { key, keys } = await fixture();
    const doc = await signDocument(key, "intyr/manifest/v1", PAYLOAD);
    expect(await verifyDocument(doc, "intyr/manifest/v1", keys)).toEqual({ ok: true });
  });

  it("does not let a plan signature pass as a manifest signature", async () => {
    // #given a document signed as a plan
    const { key, keys } = await fixture();
    const doc = await signDocument(key, "intyr/plan/v1", PAYLOAD);

    // #when someone relabels the signature as a manifest signature
    const relabeled: Signed<typeof PAYLOAD> = { ...doc, signature: { ...doc.signature, context: "intyr/manifest/v1" } };

    // #then the signed bytes no longer match, because the context is part of them
    expect(await verifyDocument(relabeled, "intyr/manifest/v1", keys)).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("reports a payload changed after signing as a hash mismatch", async () => {
    const { key, keys } = await fixture();
    const doc = await signDocument(key, "intyr/manifest/v1", PAYLOAD);
    const tampered = { ...doc, payload: { ...PAYLOAD, total_minor: 1 } };
    expect(await verifyDocument(tampered, "intyr/manifest/v1", keys)).toEqual({ ok: false, reason: "HASH_MISMATCH" });
  });

  it("reports a changed payload with a recomputed hash as an invalid signature", async () => {
    const { key, keys } = await fixture();
    const doc = await signDocument(key, "intyr/manifest/v1", PAYLOAD);
    const payload = { ...PAYLOAD, total_minor: 1 };
    const forged = { ...doc, payload, payload_hash: await payloadHash(payload) };
    expect(await verifyDocument(forged, "intyr/manifest/v1", keys)).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("rejects a signature from a key that is not published", async () => {
    const { key } = await fixture();
    const other = await fixture();
    const doc = await signDocument(key, "intyr/manifest/v1", PAYLOAD);
    const keys = [{ ...other.keys[0]!, key_id: "another-key" }];
    expect(await verifyDocument(doc, "intyr/manifest/v1", keys)).toEqual({ ok: false, reason: "UNKNOWN_KEY" });
  });

  it("rejects a signature from a revoked key", async () => {
    const { key, keys } = await fixture();
    const doc = await signDocument(key, "intyr/manifest/v1", PAYLOAD);
    const revoked = [{ ...keys[0]!, revoked: true }];
    expect(await verifyDocument(doc, "intyr/manifest/v1", revoked)).toEqual({ ok: false, reason: "KEY_REVOKED" });
  });

  it("rejects a signature made by a different key under the same key id", async () => {
    const { key } = await fixture();
    const impostor = await fixture();
    const doc = await signDocument(key, "intyr/manifest/v1", PAYLOAD);
    expect(await verifyDocument(doc, "intyr/manifest/v1", impostor.keys)).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("hashes independently of key order", async () => {
    const reordered = { legs: ["hotel", "flight"], total_minor: 40_000, trip_id: "trp_1" };
    expect(await payloadHash(reordered)).toBe(await payloadHash(PAYLOAD));
  });
});

describe("signingKeyFromJwkJson", () => {
  it("loads the private JWK text a Worker secret holds and signs verifiably", async () => {
    // #given a key exported the way it is stored as a secret
    const generated = await generateSigningKey("key-2026-10");
    const secret = JSON.stringify(generated.privateJwk);

    // #when the Worker loads it and signs
    const loaded = signingKeyFromJwkJson("key-2026-10", secret);
    const doc = await signDocument(loaded, "intyr/plan/v1", PAYLOAD);

    // #then the generated key's published form verifies it
    expect(await verifyDocument(doc, "intyr/plan/v1", [publishedKey(generated, NOW.toISOString())])).toEqual({ ok: true });
  });

  it("drops the optional JWK members that workerd refuses to import", async () => {
    // #given a JWK exported by Node, which carries alg, key_ops and ext
    const generated = await generateSigningKey("key-2026-10");
    const secret = JSON.stringify({ ...generated.privateJwk, alg: "Ed25519", key_ops: ["sign"], ext: true });

    // #when it is loaded as a Worker secret
    const loaded = signingKeyFromJwkJson("key-2026-10", secret);

    // #then only the curve members remain
    expect(Object.keys(loaded.privateJwk).sort()).toEqual(["crv", "d", "kty", "x"]);
  });

  it("refuses a public-only JWK", async () => {
    const generated = await generateSigningKey("key-2026-10");
    expect(() => signingKeyFromJwkJson("key-2026-10", JSON.stringify(generated.publicJwk))).toThrow(TypeError);
  });
});

describe("verify", () => {
  it("returns false instead of throwing on a malformed public key", async () => {
    const { key } = await fixture();
    const doc = await signDocument(key, "intyr/plan/v1", PAYLOAD);
    expect(await verify("not-a-key", doc.signature, "intyr/plan/v1", PAYLOAD)).toBe(false);
  });
});
