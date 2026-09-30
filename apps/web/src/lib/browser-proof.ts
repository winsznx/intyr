import type { ProofReport } from "@intyr/verifier";

export type { ProofReport };

export interface BrowserProofInput {
  signed: unknown;
  anchor: { network?: string; txid?: string | null } | null;
  status?: string;
}

export interface BrowserProof {
  report: ProofReport;
  headline: string;
  detail: string;
}

/**
 * Runs the independent verifier in this browser: the signature and roots through WebCrypto, the anchor and
 * payments through public Algorand nodes. Intyr's server only supplies the document and the published key list.
 * Loaded on demand so the chain client is not part of the main bundle.
 */
export async function verifyInBrowser(input: BrowserProofInput): Promise<BrowserProof> {
  const [{ verifyProof, PROOF_STATE_COPY, proofDetail }, keysResponse] = await Promise.all([
    import("@intyr/verifier"),
    fetch("/.well-known/intyr-signing-keys.json", { headers: { Accept: "application/json" } }),
  ]);
  if (!keysResponse.ok) throw new Error(`The published key list could not be loaded (HTTP ${keysResponse.status}).`);
  const keyDoc = (await keysResponse.json()) as { keys?: unknown[]; anchor_accounts?: Record<string, string> };
  const anchor = input.anchor?.txid && input.anchor.network ? { network: input.anchor.network, txid: input.anchor.txid } : null;
  const report = await verifyProof({
    signed: input.signed as Parameters<typeof verifyProof>[0]["signed"],
    keys: (keyDoc.keys ?? []) as Parameters<typeof verifyProof>[0]["keys"],
    anchor,
    ...(keyDoc.anchor_accounts && Object.keys(keyDoc.anchor_accounts).length > 0 ? { anchorAccounts: keyDoc.anchor_accounts } : {}),
    ...(input.status ? { status: input.status as NonNullable<Parameters<typeof verifyProof>[0]["status"]> } : {}),
  });
  const copy = PROOF_STATE_COPY[report.proof_state];
  return { report, headline: copy.headline, detail: proofDetail(report, anchor?.network) };
}
