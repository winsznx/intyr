import { MonitorCheck } from "lucide-react";
import { verifyInBrowser, type BrowserProof } from "../lib/browser-proof";
import { PROOF_STATE } from "../lib/labels";
import type { ProofState } from "../lib/types";
import { useResource, type Resource } from "../lib/use-resource";
import { Chip, Ring } from "./ui";

export interface StoredManifest {
  signed?: unknown;
  anchor?: { network?: string; txid?: string | null } | null;
  status?: string;
}

/** Runs the independent check once the stored document is loaded. */
export function useBrowserProof(manifestId: string, stored: StoredManifest | undefined): Resource<BrowserProof> {
  return useResource(`browser-proof:${manifestId}`, () => verifyInBrowser({ signed: stored?.signed, anchor: stored?.anchor ?? null, status: stored?.status }), {
    enabled: Boolean(stored?.signed),
  });
}

const INTEGRITY_FAILURES: ProofState[] = ["SIGNATURE_INVALID", "HASH_MISMATCH"];

/** A browser integrity failure outranks any server answer. */
export function browserOverride(proof: BrowserProof | undefined): ProofState | undefined {
  const state = proof?.report.proof_state as ProofState | undefined;
  return state && INTEGRITY_FAILURES.includes(state) ? state : undefined;
}

function anchorText(proof: BrowserProof): string {
  const anchor = proof.report.anchor as { state: string; round?: number };
  switch (anchor.state) {
    case "ANCHOR_CONFIRMED":
      return `Anchor found on Algorand in round ${anchor.round ?? "unknown"}.`;
    case "UNANCHORED":
      return "This record has no anchor transaction yet, so its timing is not proven on chain.";
    case "ANCHOR_NOT_FOUND":
      return "The named anchor transaction was not found on Algorand.";
    case "ANCHOR_UNCONFIRMED":
      return "The anchor transaction is not confirmed in a round yet.";
    case "ANCHOR_WRONG_SENDER":
      return "An anchor note exists, but it was not sent by Intyr's published anchor account.";
    case "INDEXER_UNAVAILABLE":
      return "The public Algorand indexer did not answer, so the anchor was not checked.";
    default:
      return "The anchor was not checked.";
  }
}

export function BrowserProofPanel({ proof }: { proof: Resource<BrowserProof> }) {
  if (!proof.loaded && !proof.error) {
    return (
      <section className="pf-panel pf-browser" aria-labelledby="browser-proof-title" role="status">
        <h2 id="browser-proof-title" className="pf-panel-title">
          <MonitorCheck aria-hidden /> Checked in your browser
        </h2>
        <p className="row small muted">
          <Ring label="Checking" /> Checking the signature against the published key and reading the anchor from a public Algorand node.
        </p>
      </section>
    );
  }
  if (proof.error || !proof.data) {
    return (
      <section className="pf-panel pf-browser" aria-labelledby="browser-proof-title" role="status">
        <h2 id="browser-proof-title" className="pf-panel-title">
          <MonitorCheck aria-hidden /> Checked in your browser
        </h2>
        <p className="small muted">The in-browser check could not run: {proof.error?.message ?? "no result"}. The server result below still applies.</p>
      </section>
    );
  }
  const { report, headline, detail } = proof.data;
  const label = PROOF_STATE[report.proof_state as ProofState];
  const payments = report.payments;
  const matched = payments.filter((p) => p.state === "MATCHED").length;
  return (
    <section className="pf-panel pf-browser" aria-labelledby="browser-proof-title" role="status">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="browser-proof-title" className="pf-panel-title">
          <MonitorCheck aria-hidden /> Checked in your browser
        </h2>
        <Chip tone={label?.tone ?? "outline"} enumStyle state={report.proof_state}>
          {report.proof_state}
        </Chip>
      </div>
      <p className="card-title">{headline}</p>
      <p className="small">{detail}</p>
      <ul className="pf-browser-facts small">
        <li>{report.integrity.ok ? `Signature by key ${report.key_id} and content roots verified with WebCrypto.` : "The signature or content roots did not verify. Do not rely on this record."}</li>
        <li>{anchorText(proof.data)}</li>
        <li>{payments.length ? `${matched} of ${payments.length} listed payments matched a confirmed USDC transfer on Algorand.` : "This record lists no payments."}</li>
      </ul>
      <p className="meta">
        This check ran in your browser with the verifier from the Intyr repository (packages/verifier). It used Intyr only for the document and the published key list, and read the chain from a
        public Algorand node.
      </p>
    </section>
  );
}
