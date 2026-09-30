/**
 * Note formats written to Algorand. Each purpose has its own prefix so a
 * manifest anchor can never be read as a pre-registration or the reverse.
 */
export const MANIFEST_NOTE_PREFIX = "intyr:v1:";
export const PREREGISTRATION_NOTE_PREFIX = "intyr:prereg:v1:";

/** Algorand's protocol limit for a transaction note. */
export const MAX_NOTE_BYTES = 1024;

const HEX_64 = /^[0-9a-f]{64}$/;

function hexOf(hash: string): string {
  const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  if (!HEX_64.test(hex)) throw new TypeError(`expected a sha256 hash, got "${hash}"`);
  return hex;
}

/** `intyr:v1:<hex>` for a manifest hash given as `sha256:<hex>` or bare hex. */
export function manifestAnchorNote(manifestHash: string): string {
  return MANIFEST_NOTE_PREFIX + hexOf(manifestHash);
}

/** `intyr:prereg:v1:<hex>` for the SHA-256 of a pre-registered evaluation document. */
export function preregistrationNote(documentHash: string): string {
  return PREREGISTRATION_NOTE_PREFIX + hexOf(documentHash);
}
