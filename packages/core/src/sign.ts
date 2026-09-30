import { canonicalize } from "./canonical";
import { base64url, fromBase64url, hashValue, utf8 } from "./hash";

/**
 * Every signature is domain separated: the signed bytes are the context, a
 * newline and the JCS form of the payload, so a signature made for one
 * document type can never verify as another.
 */
export const SIGNATURE_CONTEXTS = [
  "intyr/plan/v1",
  "intyr/manifest/v1",
  "intyr/transaction/v1",
  "intyr/status/v1",
  "intyr/decision/v1",
  "intyr/approval/v1",
  "intyr/receipt/v1",
  "intyr/evidence/v1",
  "intyr/export/v1",
] as const;
export type SignatureContext = (typeof SIGNATURE_CONTEXTS)[number];

export interface SigningKey {
  keyId: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export interface PublishedKey {
  key_id: string;
  alg: "Ed25519";
  public_key: string;
  valid_from: string;
  valid_to: string | null;
  revoked: boolean;
}

export interface Signature {
  alg: "Ed25519";
  key_id: string;
  context: SignatureContext;
  value: string;
}

function signedBytes(context: SignatureContext, payload: unknown): Uint8Array {
  return utf8(`${context}\n${canonicalize(payload)}`);
}

export async function generateSigningKey(keyId: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    keyId,
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
    publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
  };
}

/**
 * Loads a signing key from the JSON text of a private Ed25519 JWK, the form a
 * Worker secret holds. The public half is derived from `x`, so one secret is enough.
 */
export function signingKeyFromJwkJson(keyId: string, privateJwkJson: string): SigningKey {
  const jwk = JSON.parse(privateJwkJson) as JsonWebKey;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) {
    throw new TypeError("signingKeyFromJwkJson: expected a private Ed25519 JWK with d and x");
  }
  return { keyId, privateJwk: jwk, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x } };
}

export function publicKeyOf(key: SigningKey): string {
  if (!key.publicJwk.x) throw new TypeError("publicKeyOf: missing x");
  return key.publicJwk.x;
}

export function publishedKey(key: SigningKey, validFrom: string): PublishedKey {
  return { key_id: key.keyId, alg: "Ed25519", public_key: publicKeyOf(key), valid_from: validFrom, valid_to: null, revoked: false };
}

export async function sign(key: SigningKey, context: SignatureContext, payload: unknown): Promise<Signature> {
  const privateKey = await crypto.subtle.importKey("jwk", key.privateJwk, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, signedBytes(context, payload) as BufferSource);
  return { alg: "Ed25519", key_id: key.keyId, context, value: base64url(new Uint8Array(sig)) };
}

/** Verifies against a base64url raw Ed25519 public key. Malformed input yields false, never a throw. */
export async function verify(
  publicKey: string,
  signature: Signature,
  expectedContext: SignatureContext,
  payload: unknown,
): Promise<boolean> {
  if (signature.alg !== "Ed25519" || signature.context !== expectedContext) return false;
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64url(publicKey) as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64url(signature.value) as BufferSource,
      signedBytes(expectedContext, payload) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** `sha256:<hex>` of the JCS form of a payload. */
export async function payloadHash(payload: unknown): Promise<string> {
  return hashValue(canonicalize(payload));
}

export interface Signed<T> {
  payload: T;
  payload_hash: string;
  signature: Signature;
}

export async function signDocument<T>(key: SigningKey, context: SignatureContext, payload: T): Promise<Signed<T>> {
  return { payload, payload_hash: await payloadHash(payload), signature: await sign(key, context, payload) };
}

export type DocumentCheck =
  | { ok: true }
  | { ok: false; reason: "HASH_MISMATCH" | "SIGNATURE_INVALID" | "UNKNOWN_KEY" | "KEY_REVOKED" };

/** Checks hash and signature of a signed document against the published key set. */
export async function verifyDocument<T>(
  doc: Signed<T>,
  context: SignatureContext,
  keys: PublishedKey[],
): Promise<DocumentCheck> {
  if ((await payloadHash(doc.payload)) !== doc.payload_hash) return { ok: false, reason: "HASH_MISMATCH" };
  const key = keys.find((k) => k.key_id === doc.signature.key_id);
  if (!key) return { ok: false, reason: "UNKNOWN_KEY" };
  if (key.revoked) return { ok: false, reason: "KEY_REVOKED" };
  const valid = await verify(key.public_key, doc.signature, context, doc.payload);
  return valid ? { ok: true } : { ok: false, reason: "SIGNATURE_INVALID" };
}
