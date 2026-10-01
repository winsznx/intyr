import { useId, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ArrowUpRight, FileSearch, FlaskConical } from "lucide-react";
import { ButtonLink } from "../../components/ui";

/* ------------------------------------------------------------------ */
/* /evidence                                                           */
/* ------------------------------------------------------------------ */

export function EvidenceIndexPage() {
  return (
    <div className="container section-tight pf-page">
      <header className="pf-head">
        <span className="badge">
          <FlaskConical aria-hidden />
          Evidence
        </span>
        <h1 className="h2">The record behind the claims</h1>
        <div className="pf-lede">
          <p className="body-l">
            The evidence bundle is the published record behind Intyr's claims. RUN-001 is a paid call on Algorand Mainnet: a caller paid for a trip
            check in USDC over x402, and Intyr returned a signed commit plan anchored on Algorand. The team paid it from its own wallet, so it is
            labeled INTERNAL_VALIDATION and is not outside adoption.
          </p>
          <p className="body">
            campaign-001 is a pre-registered campaign on the seeded simulator. A naive agent, an independently written script and Intyr face the same
            supplier faults, and each run is kept with its result. Intyr matched the script in ten of eleven cells and lost one. Suppliers in both are
            sandbox or simulated.
          </p>
          <p className="body">
            Both are public on their own. RUN-001's plan and payment are on Algorand Mainnet, and the campaign's results and per-run records are
            committed in the repository.
          </p>
        </div>
      </header>

      <div className="pf-evidence-grid">
        <EvidenceCard runId="RUN-001" title="Canonical run" summary="A paid Mainnet check: the USDC payment and the signed, anchored commit plan it bought.">
          <Run001Links />
        </EvidenceCard>
        <EvidenceCard
          runId="campaign-001"
          title="TestNet campaign"
          summary="The same supplier faults against three approaches: a naive agent, an independently written script, and Intyr."
        >
          <CampaignResults />
        </EvidenceCard>
      </div>
    </div>
  );
}

const CAMPAIGN_RESULTS_URL = "https://github.com/winsznx/intyr/blob/main/evidence/campaign-001/RESULTS.md";

const RUN_001 = {
  planId: "pln_357c45b828fabcb25b5e271e",
  paymentTxUrl: "https://allo.info/tx/2MD7RMXDHTLVE76ZNTAOZKZCYEPLF7AIBBOAGZQEO6JOFQLNLVPA",
};

function CampaignResults() {
  return (
    <div className="pf-ev-empty">
      <p className="pf-ev-empty-title">Results are in the repository</p>
      <p className="small muted">
        110 runs per approach on the seeded simulator. The naive agent ended consistent in 36% of runs with 20 duplicate orders, the script in 100%,
        and Intyr in 92% with no duplicates. Intyr lost one cell, where a hotel refused every cancellation, and reported the stranded hotel each
        time. Per-run records are committed with the results.
      </p>
      <a className="pf-ext" href={CAMPAIGN_RESULTS_URL} target="_blank" rel="noreferrer">
        Read the campaign results on GitHub
        <ArrowUpRight aria-hidden />
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </div>
  );
}

/** RUN-001 is the plan and the payment themselves, so the card links both. */
function Run001Links() {
  return (
    <div className="pf-ev-empty">
      <p className="small muted">Its plan and payment are public on Algorand Mainnet.</p>
      <Link className="pf-ext" to={`/verify/${RUN_001.planId}`}>
        RUN-001, Mainnet, team-paid, INTERNAL_VALIDATION
      </Link>
      <a className="pf-ext" href={RUN_001.paymentTxUrl} target="_blank" rel="noreferrer">
        The USDC payment on Algorand Mainnet
        <ArrowUpRight aria-hidden />
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </div>
  );
}

function EvidenceCard({ runId, title, summary, children }: { runId: string; title: string; summary: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <article className="pf-ev-card" aria-labelledby={titleId}>
      <div className="pf-ev-card-head">
        <span className="pf-eyebrow">{runId}</span>
        <h2 id={titleId} className="title-s">
          {title}
        </h2>
        <p className="body">{summary}</p>
      </div>
      <div className="pf-ev-card-body">{children}</div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* /evidence/:runId                                                    */
/* ------------------------------------------------------------------ */

const STATIC_RUNS: Record<string, { title: string; summary: string; body: ReactNode }> = {
  "RUN-001": {
    title: "Canonical run",
    summary:
      "A paid call on Algorand Mainnet: a caller paid for a trip check in USDC over x402, and Intyr returned a signed commit plan anchored on Algorand. The team paid it from its own wallet, so it is labeled INTERNAL_VALIDATION and is not outside adoption.",
    body: <Run001Links />,
  },
  "campaign-001": {
    title: "TestNet campaign",
    summary: "A pre-registered campaign on the seeded simulator. A naive agent, an independently written script and Intyr face the same supplier faults, 110 runs each.",
    body: <CampaignResults />,
  },
};

/** The published runs are the records the repository and the chain already hold, so these pages never call the API. */
export function EvidenceRunPage() {
  const { runId = "" } = useParams();
  const run = Object.hasOwn(STATIC_RUNS, runId) ? STATIC_RUNS[runId] : undefined;
  return (
    <div className="container section-tight pf-page">
      <Link to="/evidence" className="pf-back">
        <ArrowLeft aria-hidden />
        Evidence
      </Link>
      {run ? (
        <>
          <header className="pf-head">
            <p className="pf-eyebrow">{runId}</p>
            <h1 className="title-l">{run.title}</h1>
            <p className="body-l pf-measure">{run.summary}</p>
          </header>
          <div className="pf-panel">{run.body}</div>
        </>
      ) : (
        <div className="pf-state" role="status">
          <span className="pf-state-icon">
            <FileSearch aria-hidden />
          </span>
          <h1 className="title-m">No published run has this id</h1>
          <p className="body">The published runs are RUN-001 and campaign-001, both listed on the evidence page.</p>
          <ButtonLink to="/evidence" variant="secondary">
            See the evidence
          </ButtonLink>
        </div>
      )}
    </div>
  );
}
