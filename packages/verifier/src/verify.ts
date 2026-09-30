import {
  integrityProofState,
  verifyManifestDocument,
  type EvidenceBanner,
  type ManifestCheck,
  type ManifestStatus,
  type PaymentRef,
  type ProofState,
  type PublishedKey,
  type Signed,
  type SignedRecord,
} from "@intyr/core";
import {
  checkManifestAnchor,
  matchTransfer,
  NETWORKS,
  networkByCaip2,
  readAssetTransfer,
  type AnchorCheck,
  type ChainEndpoints,
  type FetchLike,
  type TransferCheck,
} from "@intyr/chain";

/** A commit plan from check, a commit manifest from prepare or revalidate, or a final transaction manifest. */
export type VerifiableManifest = SignedRecord;

export interface ProofInput {
  signed: Signed<VerifiableManifest>;
  /** Published key set: /.well-known/intyr-signing-keys.json, or a copy pinned by the verifier. */
  keys: PublishedKey[];
  /** Where the payload hash was anchored, as the manifest read route reports it. Null when it was not anchored. */
  anchor: { network: string; txid: string } | null;
  /** Published anchor account per CAIP-2 network. When given, a matching note from any other sender does not count. */
  anchorAccounts?: Record<string, string>;
  /** Current status from the manifest's status record, when known. */
  status?: ManifestStatus;
}

export interface ProofOptions {
  fetch?: FetchLike;
  /** Endpoints per CAIP-2 network. Defaults to the public Nodely nodes, never Intyr's own. */
  endpoints?: Record<string, ChainEndpoints>;
  now?: () => Date;
}

export type AnchorResult =
  | AnchorCheck
  | { state: "UNANCHORED" }
  | { state: "UNKNOWN_NETWORK"; network: string }
  | { state: "NOT_CHECKED" };

export type PaymentResult =
  | { txid: string; network: string; state: "MATCHED"; round: number }
  | { txid: string; network: string; state: "MISMATCH"; reason: Exclude<TransferCheck, { ok: true }>["reason"] | "NOT_A_TRANSFER" }
  | { txid: string; network: string; state: "PENDING" | "NOT_FOUND" | "UNAVAILABLE" | "UNKNOWN_NETWORK" };

export interface ProofReport {
  proof_state: ProofState;
  /** The manifest id, or the plan id for a commit plan. */
  manifest_id: string;
  schema_version: VerifiableManifest["schema_version"];
  environment: VerifiableManifest["environment"];
  payload_hash: string;
  key_id: string;
  integrity: ManifestCheck;
  anchor: AnchorResult;
  payments: PaymentResult[];
  evidence_banner: EvidenceBanner;
  verified_at: string;
  /** What a PROOF_VERIFIED result establishes, and what it does not. */
  scope: { proves: string[]; does_not_prove: string[] };
}

const SCOPE: ProofReport["scope"] = {
  proves: [
    "The published Intyr key signed exactly this document.",
    "Its component and decision roots match the records it contains.",
    "When anchored, the document existed unchanged at the anchor round on Algorand.",
    "Each listed payment is a confirmed USDC transfer with the recorded asset, receiver, amount and payer.",
  ],
  does_not_prove: [
    "That a supplier kept a booking after it was read back, or that supplier or caller data is true.",
    "Anything about components whose evidence grade is SIMULATED or CALLER_ASSERTED beyond what they claim.",
    "That the published key belongs to Intyr, unless the key was pinned from a source other than the host being checked.",
  ],
};

function endpointsFor(network: string, options: ProofOptions): ChainEndpoints | undefined {
  return options.endpoints?.[network] ?? networkByCaip2(network) ?? (network in NETWORKS ? NETWORKS[network as keyof typeof NETWORKS] : undefined);
}

async function checkPayment(payment: PaymentRef, options: ProofOptions): Promise<PaymentResult> {
  const { txid, network } = payment;
  const net = endpointsFor(network, options);
  if (!net) return { txid, network, state: "UNKNOWN_NETWORK" };
  const read = await readAssetTransfer(net, txid, options.fetch ?? fetch);
  switch (read.state) {
    case "CONFIRMED": {
      const match = matchTransfer(read.transfer, {
        assetId: payment.asset_id,
        receiver: payment.pay_to,
        amount: payment.amount_minor,
        sender: payment.payer,
      });
      return match.ok ? { txid, network, state: "MATCHED", round: read.transfer.round } : { txid, network, state: "MISMATCH", reason: match.reason };
    }
    case "NOT_A_TRANSFER":
      return { txid, network, state: "MISMATCH", reason: "NOT_A_TRANSFER" };
    default:
      return { txid, network, state: read.state };
  }
}

function paymentsOf(record: VerifiableManifest): PaymentRef[] {
  if (record.schema_version === "commit-plan/1") return [];
  const outbound = record.schema_version === "transaction-manifest/1" ? record.outbound_payments : [];
  return [...record.inbound_payments, ...outbound].filter((p) => p.txid.length > 0);
}

/** A plan's legs are described by the caller and never read from a supplier. */
function bannerOf(record: VerifiableManifest): EvidenceBanner {
  return record.schema_version === "commit-plan/1" ? "CALLER_ASSERTED" : record.evidence_banner;
}

function idOf(record: VerifiableManifest): string {
  return record.schema_version === "commit-plan/1" ? record.plan_id : record.manifest_id;
}

function anchorProofState(anchor: AnchorResult): ProofState {
  switch (anchor.state) {
    case "ANCHOR_CONFIRMED":
      return "PROOF_VERIFIED";
    case "ANCHOR_UNCONFIRMED":
      return "ANCHOR_UNCONFIRMED";
    case "ANCHOR_NOT_FOUND":
    case "ANCHOR_WRONG_SENDER":
      return "ANCHOR_NOT_FOUND";
    case "HASH_MISMATCH":
      return "HASH_MISMATCH";
    case "INDEXER_UNAVAILABLE":
      return "INDEXER_UNAVAILABLE";
    default:
      return "PROOF_PARTIAL";
  }
}

/**
 * Verifies a signed manifest from public inputs only: the document, the
 * published key set and the Algorand record read from public nodes. Nothing
 * here asks Intyr's server whether the document is valid.
 */
export async function verifyProof(input: ProofInput, options: ProofOptions = {}): Promise<ProofReport> {
  const { signed } = input;
  const record = signed.payload;
  const base = {
    manifest_id: idOf(record),
    schema_version: record.schema_version,
    environment: record.environment,
    payload_hash: signed.payload_hash,
    key_id: signed.signature.key_id,
    evidence_banner: bannerOf(record),
    verified_at: (options.now?.() ?? new Date()).toISOString(),
    scope: SCOPE,
  };

  const integrity = await verifyManifestDocument(signed, input.keys);
  const broken = integrityProofState(integrity);
  if (broken) return { ...base, proof_state: broken, integrity, anchor: { state: "NOT_CHECKED" }, payments: [] };

  let anchor: AnchorResult = { state: "UNANCHORED" };
  if (input.anchor) {
    const net = endpointsFor(input.anchor.network, options);
    const anchorAddress = input.anchorAccounts?.[input.anchor.network];
    anchor = net
      ? await checkManifestAnchor(net, input.anchor.txid, signed.payload_hash, {
          ...(anchorAddress ? { anchorAddress } : {}),
          fetch: options.fetch ?? fetch,
        })
      : { state: "UNKNOWN_NETWORK", network: input.anchor.network };
  }
  const payments = await Promise.all(paymentsOf(record).map((p) => checkPayment(p, options)));

  let proof_state = anchorProofState(anchor);
  if (proof_state === "PROOF_VERIFIED" && payments.some((p) => p.state !== "MATCHED")) proof_state = "PROOF_PARTIAL";
  if (input.status === "SUPERSEDED" && (proof_state === "PROOF_VERIFIED" || proof_state === "PROOF_PARTIAL")) {
    proof_state = "MANIFEST_SUPERSEDED";
  }
  return { ...base, proof_state, integrity, anchor, payments };
}
