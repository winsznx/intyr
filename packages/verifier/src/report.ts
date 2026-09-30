import { explorerTxUrl, networkByCaip2 } from "@intyr/chain";
import type { ProofState } from "@intyr/core";
import type { AnchorResult, PaymentResult, ProofReport } from "./verify";

/** Headline and detail per proof state, shared with the web proof page (PRD v3 A8.5). */
export const PROOF_STATE_COPY: Record<ProofState, { headline: string; detail: string }> = {
  PROOF_VERIFIED: {
    headline: "Verified",
    detail: "Signed by Intyr, unchanged since signing, and anchored on Algorand {network} in round {round}.",
  },
  PROOF_PARTIAL: {
    headline: "Partly verified",
    detail: "The signature and content check out. {pending}",
  },
  SIGNATURE_INVALID: {
    headline: "Signature does not match",
    detail: "This record was not signed by a published Intyr key, or it changed after signing. Do not rely on it.",
  },
  HASH_MISMATCH: {
    headline: "Content changed",
    detail: "The content does not match the hash that was signed and anchored. Do not rely on it.",
  },
  ANCHOR_NOT_FOUND: {
    headline: "Anchor not found",
    detail: "The anchor transaction named in this record is not on Algorand {network}, or it does not carry this hash. The timing is unproven.",
  },
  ANCHOR_UNCONFIRMED: {
    headline: "Anchor pending",
    detail: "The anchor transaction is not confirmed in a round yet.",
  },
  MANIFEST_SUPERSEDED: {
    headline: "Replaced by a newer record",
    detail: "This record was valid and was superseded. The newer record is current.",
  },
  INDEXER_UNAVAILABLE: {
    headline: "Chain check unavailable",
    detail: "No Algorand indexer answered, so the anchor and payment checks did not run. The signature and content checks did.",
  },
};

function networkLabel(caip2: string): string {
  return networkByCaip2(caip2)?.name ?? caip2;
}

/** Names what kept a proof partial, one sentence per gap. */
function pendingChecks(report: ProofReport): string {
  const gaps: string[] = [];
  if (report.anchor.state === "UNANCHORED") gaps.push("It has no anchor on Algorand yet, so its timing is unproven.");
  else if (report.anchor.state === "UNKNOWN_NETWORK") gaps.push("Its anchor is on a network this verifier does not know.");
  const unmatched = report.payments.filter((p) => p.state !== "MATCHED").length;
  if (unmatched > 0) gaps.push(`${unmatched} of ${report.payments.length} listed payments could not be matched on chain.`);
  return gaps.join(" ");
}

/** Fills the detail template of a report's proof state. */
export function proofDetail(report: ProofReport, network?: string): string {
  const round = report.anchor.state === "ANCHOR_CONFIRMED" ? String(report.anchor.round) : "?";
  return PROOF_STATE_COPY[report.proof_state].detail
    .replace("{network}", network ? networkLabel(network) : "")
    .replace("{round}", round)
    .replace("{pending}", pendingChecks(report))
    .replace(/\s{2,}/g, " ");
}

function anchorLine(anchor: AnchorResult, network?: string): string {
  const explorer = (txid: string) => {
    const net = network ? networkByCaip2(network) : undefined;
    return net ? `  ${explorerTxUrl(net, txid)}` : "";
  };
  switch (anchor.state) {
    case "ANCHOR_CONFIRMED":
      return `confirmed in round ${anchor.round}, sent by ${anchor.sender}${explorer(anchor.txid)}`;
    case "ANCHOR_UNCONFIRMED":
      return `transaction ${anchor.txid} is not confirmed yet`;
    case "ANCHOR_NOT_FOUND":
      return `transaction ${anchor.txid} was not found`;
    case "ANCHOR_WRONG_SENDER":
      return `transaction ${anchor.txid} carries the hash but was sent by ${anchor.sender}, not the published anchor account`;
    case "HASH_MISMATCH":
      return `transaction ${anchor.txid} carries a different note: ${anchor.note ?? "(none)"}`;
    case "INDEXER_UNAVAILABLE":
      return `indexer unavailable (${anchor.reason})`;
    case "UNKNOWN_NETWORK":
      return `anchored on ${anchor.network}, which this verifier does not know`;
    case "UNANCHORED":
      return "not anchored";
    case "NOT_CHECKED":
      return "not checked, the document failed its integrity check";
  }
}

function paymentLine(payment: PaymentResult): string {
  const label = `${payment.txid} on ${networkLabel(payment.network)}`;
  switch (payment.state) {
    case "MATCHED":
      return `${label}: matches, round ${payment.round}`;
    case "MISMATCH":
      return `${label}: does not match (${payment.reason})`;
    default:
      return `${label}: ${payment.state}`;
  }
}

function integrityLine(report: ProofReport): string {
  if (report.integrity.ok) {
    const roots: Record<ProofReport["schema_version"], string> = {
      "commit-plan/1": "",
      "commit-manifest/1": ", component root matches",
      "transaction-manifest/1": ", component and decision roots match",
    };
    return `signature valid with key ${report.key_id}, payload hash matches${roots[report.schema_version]}`;
  }
  return `failed: ${report.integrity.reason}`;
}

/** Plain text report for the terminal. */
export function renderReport(report: ProofReport, anchorNetwork?: string): string {
  const copy = PROOF_STATE_COPY[report.proof_state];
  const lines = [
    `Intyr proof check for ${report.manifest_id} (${report.schema_version}, ${report.environment})`,
    `  payload hash  ${report.payload_hash}`,
    `  integrity     ${integrityLine(report)}`,
    `  anchor        ${anchorLine(report.anchor, anchorNetwork)}`,
    `  payments      ${report.payments.length === 0 ? "none listed" : `${report.payments.filter((p) => p.state === "MATCHED").length} of ${report.payments.length} match the chain`}`,
    ...report.payments.map((p) => `                ${paymentLine(p)}`),
    `  evidence      ${report.evidence_banner === "NONE" ? "no simulated or caller-asserted components" : `contains ${report.evidence_banner} components`}`,
    "",
    `${report.proof_state}: ${copy.headline}. ${proofDetail(report, anchorNetwork)}`,
    "",
    "A verified proof shows:",
    ...report.scope.proves.map((s) => `  - ${s}`),
    "It does not show:",
    ...report.scope.does_not_prove.map((s) => `  - ${s}`),
  ];
  return lines.join("\n");
}
