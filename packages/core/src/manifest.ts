import { canonicalize } from "./canonical";
import { hashValue, sha256Hex } from "./hash";
import { signDocument, verifyDocument, type PublishedKey, type Signed, type SigningKey } from "./sign";
import type { CommitManifest, ManifestComponent, ManifestStatusRecord, TransactionManifest } from "./types";
import type { EvidenceBanner, ManifestStatus } from "./vocab";

const EMPTY_ROOT_INPUT = "intyr/empty-root";

function stripPrefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

/**
 * Binary Merkle root over leaf hashes in the given order. An odd node is
 * paired with itself. Leaves and nodes are `sha256:` prefixed hex.
 */
export async function merkleRoot(leafHashes: string[]): Promise<string> {
  if (leafHashes.length === 0) return "sha256:" + (await sha256Hex(EMPTY_ROOT_INPUT));
  let level = leafHashes.map(stripPrefix);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(await sha256Hex(left + right));
    }
    level = next;
  }
  return "sha256:" + level[0]!;
}

export async function componentLeaf(component: ManifestComponent): Promise<string> {
  return hashValue(canonicalize(component));
}

export async function componentRoot(components: ManifestComponent[]): Promise<string> {
  return merkleRoot(await Promise.all(components.map(componentLeaf)));
}

/** The weakest evidence in a manifest decides its banner. */
export function evidenceBanner(components: ManifestComponent[]): EvidenceBanner {
  const grades = new Set(components.map((c) => c.evidence_grade));
  if (grades.has("SIMULATED")) return "SIMULATED";
  if (grades.has("CALLER_ASSERTED")) return "CALLER_ASSERTED";
  if (grades.has("SUPPLIER_SANDBOX")) return "SUPPLIER_SANDBOX";
  return "NONE";
}

export type CommitManifestInput = Omit<CommitManifest, "schema_version" | "component_root" | "evidence_banner">;

export async function buildCommitManifest(input: CommitManifestInput): Promise<CommitManifest> {
  return {
    schema_version: "commit-manifest/1",
    ...input,
    component_root: await componentRoot(input.components),
    evidence_banner: evidenceBanner(input.components),
  };
}

export type TransactionManifestInput = Omit<
  TransactionManifest,
  "schema_version" | "component_root" | "decisions_root" | "evidence_banner"
>;

export async function buildTransactionManifest(input: TransactionManifestInput): Promise<TransactionManifest> {
  return {
    schema_version: "transaction-manifest/1",
    ...input,
    component_root: await componentRoot(input.components),
    decisions_root: await merkleRoot(input.decisions.map((d) => d.decision_hash)),
    evidence_banner: evidenceBanner(input.components),
  };
}

export function signCommitManifest(key: SigningKey, manifest: CommitManifest): Promise<Signed<CommitManifest>> {
  return signDocument(key, "intyr/manifest/v1", manifest);
}

export function signTransactionManifest(key: SigningKey, manifest: TransactionManifest): Promise<Signed<TransactionManifest>> {
  return signDocument(key, "intyr/transaction/v1", manifest);
}

export function signStatusRecord(key: SigningKey, record: ManifestStatusRecord): Promise<Signed<ManifestStatusRecord>> {
  return signDocument(key, "intyr/status/v1", record);
}

export function statusRecord(
  manifestId: string,
  manifestHash: string,
  status: ManifestStatus,
  at: Date,
  supersededBy?: string,
): ManifestStatusRecord {
  return {
    schema_version: "manifest-status/1",
    manifest_id: manifestId,
    manifest_hash: manifestHash,
    status,
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    at: at.toISOString(),
  };
}

export type ManifestCheck =
  | { ok: true }
  | { ok: false; reason: "HASH_MISMATCH" | "SIGNATURE_INVALID" | "UNKNOWN_KEY" | "KEY_REVOKED" | "COMPONENT_ROOT_MISMATCH" };

/**
 * Offline integrity check: payload hash, signature, and a recomputed component
 * root. Chain linkage is checked separately against a public indexer.
 */
export async function verifyManifestDocument<T extends CommitManifest | TransactionManifest>(
  doc: Signed<T>,
  keys: PublishedKey[],
): Promise<ManifestCheck> {
  const context = doc.payload.schema_version === "commit-manifest/1" ? "intyr/manifest/v1" : "intyr/transaction/v1";
  const check = await verifyDocument(doc, context, keys);
  if (!check.ok) return check;
  if ((await componentRoot(doc.payload.components)) !== doc.payload.component_root) {
    return { ok: false, reason: "COMPONENT_ROOT_MISMATCH" };
  }
  return { ok: true };
}
