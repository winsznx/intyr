import { useId, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ArrowUpRight, CirclePlay, FileSearch, FlaskConical, Route } from "lucide-react";
import { ApiError } from "../../lib/api";
import type { EvidenceRun } from "../../lib/types";
import type { Resource } from "../../lib/use-resource";
import { Button, ButtonLink, Chip, ErrorState, HashText, Skeleton } from "../../components/ui";
import {
  AnchorList,
  EnvChip,
  EventType,
  NotProvided,
  PaymentList,
  SupplierModeChip,
  SupplierScopeBanner,
  clockTime,
  environmentOf,
  fullTime,
  isNotAvailable,
  isNotFound,
  isSandboxMode,
  labelFromCode,
  orderEvents,
  pick,
  readAnchors,
  readPayments,
  readText,
  useEvidenceRun,
  when,
} from "../../components/proof-parts";

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
          <p className="body">Figures come from the API. Where the API does not serve a record yet, the card says so and links the results committed in the repository.</p>
        </div>
      </header>

      <div className="pf-evidence-grid">
        <EvidenceCard
          runId="RUN-001"
          title="Canonical run"
          summary="A paid Mainnet check: the USDC payment and the signed, anchored commit plan it bought."
          notFound={<Run001Links />}
        />
        <EvidenceCard
          runId="campaign-001"
          title="TestNet campaign"
          summary="The same supplier faults against three approaches: a naive agent, an independently written script, and Intyr."
          notFound={
            <div className="pf-ev-empty">
              <p className="pf-ev-empty-title">Results are in the repository</p>
              <p className="small muted">
                110 runs per approach on the seeded simulator. The naive agent ended consistent in 36% of runs with 20 duplicate orders, the script in
                100%, and Intyr in 92% with no duplicates. Intyr lost one cell, where a hotel refused every cancellation, and reported the stranded hotel
                each time. The API does not serve this campaign yet.
              </p>
              <a className="pf-ext" href={CAMPAIGN_RESULTS_URL} target="_blank" rel="noreferrer">
                Read the campaign results on GitHub
                <ArrowUpRight aria-hidden />
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </div>
          }
        />
      </div>
    </div>
  );
}

const CAMPAIGN_RESULTS_URL = "https://github.com/winsznx/intyr/blob/main/evidence/campaign-001/RESULTS.md";

const RUN_001 = {
  planId: "pln_357c45b828fabcb25b5e271e",
  paymentTxUrl: "https://allo.info/tx/2MD7RMXDHTLVE76ZNTAOZKZCYEPLF7AIBBOAGZQEO6JOFQLNLVPA",
};

/** The API serves no evidence route for RUN-001, so the card links the records that exist: the plan and its payment. */
function Run001Links() {
  return (
    <div className="pf-ev-empty">
      <p className="small muted">The API does not serve an evidence record for this run. Its plan and payment are public on their own.</p>
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

function EvidenceCard({ runId, title, summary, notFound }: { runId: string; title: string; summary: string; notFound: ReactNode }) {
  const run = useEvidenceRun(runId);
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
      <div className="pf-ev-card-body" role="status" aria-busy={run.loading || undefined}>
        {run.loaded && isNotFound(run.error) ? notFound : <EvidenceCardBody runId={runId} run={run} />}
      </div>
    </article>
  );
}

function EvidenceCardBody({ runId, run }: { runId: string; run: Resource<EvidenceRun> }) {
  if (!run.loaded) {
    return (
      <div className="pf-skel-list">
        <span className="visually-hidden">Loading {runId}</span>
        <Skeleton height={18} width="60%" />
        <Skeleton height={18} width="80%" />
        <Skeleton height={18} width="45%" />
      </div>
    );
  }
  if (run.error) {
    const unreachable = run.error instanceof ApiError && run.error.unreachable;
    return (
      <div className="pf-ev-empty">
        <p className="pf-ev-empty-title">
          {unreachable ? "The Intyr API is not reachable" : isNotAvailable(run.error) ? "Not available right now" : "This record did not load"}
        </p>
        <p className="small muted">{(run.error instanceof ApiError ? readText(run.error.body.message) : undefined) ?? "Try again in a moment."}</p>
        {run.error instanceof ApiError ? <code className="meta">{run.error.code}</code> : null}
        <div>
          <Button variant="secondary" size="sm" onClick={run.reload} loading={run.loading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const data: unknown = run.data;
  const label = readText(pick(data, "label"));
  const payments = pick(data, "payments");
  const anchors = pick(data, "anchors");
  const events = pick(data, "events");
  const manifestId = readText(pick(data, "manifest_id"));
  return (
    <>
      {label ? <p className="pf-ev-label">{label}</p> : null}
      <dl className="kv pf-kv">
        <dt>Environment</dt>
        <dd>
          <EnvChip environment={pick(data, "environment")} />
        </dd>
        <dt>Status</dt>
        <dd>
          <RunStatusChip status={readText(pick(data, "status"))} />
        </dd>
        <dt>Supplier mode</dt>
        <dd>
          <SupplierModeChip mode={readText(pick(data, "supplier_mode"))} />
        </dd>
        <dt>Scenario</dt>
        <dd>{readText(pick(data, "scenario")) ?? <NotProvided />}</dd>
        <dt>Payments</dt>
        <dd className="num">{Array.isArray(payments) ? payments.length : <NotProvided />}</dd>
        <dt>Anchors</dt>
        <dd className="num">{Array.isArray(anchors) ? anchors.length : <NotProvided />}</dd>
        <dt>Recorded events</dt>
        <dd className="num">{Array.isArray(events) ? events.length : <NotProvided />}</dd>
      </dl>
      <div className="pf-ev-actions">
        <ButtonLink to={`/evidence/${encodeURIComponent(runId)}`} size="sm">
          Open the run
        </ButtonLink>
        {manifestId ? (
          <ButtonLink to={`/verify/${encodeURIComponent(manifestId)}`} variant="secondary" size="sm">
            Verify its manifest
          </ButtonLink>
        ) : null}
        {Array.isArray(events) && events.length > 0 ? (
          <ButtonLink to={`/replay/${encodeURIComponent(runId)}`} variant="quiet" size="sm">
            Replay
          </ButtonLink>
        ) : null}
      </div>
    </>
  );
}

function RunStatusChip({ status }: { status: string | undefined }) {
  if (!status) return <NotProvided />;
  return (
    <Chip tone="neutral" enumStyle title={labelFromCode(status)}>
      {status}
    </Chip>
  );
}

/* ------------------------------------------------------------------ */
/* /evidence/:runId                                                    */
/* ------------------------------------------------------------------ */

export function EvidenceRunPage() {
  const { runId = "" } = useParams();
  const run = useEvidenceRun(runId);

  return (
    <div className="container section-tight pf-page">
      <Link to="/evidence" className="pf-back">
        <ArrowLeft aria-hidden />
        Evidence
      </Link>
      {!run.loaded ? (
        <div className="pf-head" role="status" aria-busy="true">
          <span className="visually-hidden">Loading run {runId}</span>
          <Skeleton width={120} height={14} />
          <Skeleton width="min(560px, 100%)" height={40} />
          <Skeleton width="min(360px, 70%)" height={24} />
        </div>
      ) : run.error && isNotFound(run.error) ? (
        <div className="pf-state" role="status">
          <span className="pf-state-icon">
            <FileSearch aria-hidden />
          </span>
          <h1 className="title-m">{runId} is not published yet</h1>
          <p className="body">The API has no evidence record with this id. Published runs are listed on the evidence page.</p>
          {runId === "RUN-001" ? <Run001Links /> : null}
          {runId === "campaign-001" ? (
            <a className="pf-ext" href={CAMPAIGN_RESULTS_URL} target="_blank" rel="noreferrer">
              Results are in the repository, run on the seeded simulator
              <ArrowUpRight aria-hidden />
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          ) : null}
          <ButtonLink to="/evidence" variant="secondary">
            See the evidence
          </ButtonLink>
        </div>
      ) : run.error ? (
        <>
          <div className="pf-head">
            <p className="pf-eyebrow">{runId}</p>
            <h1 className="title-m">This run could not be loaded</h1>
          </div>
          <div className="pf-panel" role="status">
            <ErrorState error={run.error} what="this run" onRetry={run.reload} />
          </div>
        </>
      ) : run.data ? (
        <RunDetail runId={runId} run={run.data} />
      ) : null}
    </div>
  );
}

function RunDetail({ runId, run }: { runId: string; run: EvidenceRun }) {
  const uid = useId();
  const source: unknown = run;
  const label = readText(pick(source, "label"));
  const supplierMode = readText(pick(source, "supplier_mode"));
  const manifestId = readText(pick(source, "manifest_id"));
  const tripId = readText(pick(source, "trip_id"));
  const environment = pick(source, "environment");
  const status = readText(pick(source, "status"));
  const events = orderEvents(pick(source, "events"));
  const anchors = readAnchors(pick(source, "anchors"));
  const payments = readPayments(pick(source, "payments"));
  const rawLimitations = pick(source, "limitations");
  const limitations = Array.isArray(rawLimitations) ? rawLimitations.map(readText).filter((l): l is string => l !== undefined) : undefined;

  return (
    <>
      <header className="pf-head">
        <p className="pf-eyebrow">{readText(pick(source, "run_id")) ?? runId}</p>
        <h1 className="title-l">{label ?? runId}</h1>
        <div className="pf-meta" role="status">
          <span className="visually-hidden">Run loaded.</span>
          {environmentOf(environment) ? <EnvChip environment={environment} /> : null}
          {status ? <RunStatusChip status={status} /> : null}
          {supplierMode ? <SupplierModeChip mode={supplierMode} /> : null}
        </div>
        <div className="pf-ev-actions">
          {manifestId ? (
            <ButtonLink to={`/verify/${encodeURIComponent(manifestId)}`}>
              <FileSearch aria-hidden />
              Verify the manifest
            </ButtonLink>
          ) : null}
          <ButtonLink to={`/replay/${encodeURIComponent(runId)}`} variant="secondary">
            <CirclePlay aria-hidden />
            Step through the replay
          </ButtonLink>
          {tripId ? (
            <ButtonLink to={`/app/trips/${encodeURIComponent(tripId)}`} variant="quiet">
              <Route aria-hidden />
              Open the trip
            </ButtonLink>
          ) : null}
        </div>
        {tripId ? (
          <p className="pf-note">
            The trip page loads only when this trip belongs to your own sandbox session. From any other browser it shows as not found.
          </p>
        ) : null}
      </header>

      {isSandboxMode(supplierMode) ? <SupplierScopeBanner /> : null}

      <div className="pf-run-grid">
        <div className="pf-col">
          <section className="pf-panel" aria-labelledby={`${uid}-events`}>
            <h2 id={`${uid}-events`} className="pf-panel-title">
              Events, oldest first
            </h2>
            {events.length === 0 ? (
              <p className="pf-empty">This run has no recorded events.</p>
            ) : (
              <ol className="pf-timeline">
                {events.map((event) => (
                  <li key={`${event.index}-${event.at ?? ""}`} className="pf-tl-item">
                    <span className="pf-tl-dot" aria-hidden />
                    <div className="pf-tl-body">
                      <div className="pf-tl-head">
                        <EventType type={event.type} />
                        {event.at ? (
                          <time className="pf-tl-time" dateTime={event.at} title={fullTime(event.at)}>
                            {clockTime(event.at)}
                          </time>
                        ) : (
                          <span className="pf-tl-time">Time not provided</span>
                        )}
                      </div>
                      {event.detail ? <p className="pf-tl-detail">{event.detail}</p> : null}
                      {event.hash ? <HashText value={event.hash} label="event hash" /> : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="pf-panel" aria-labelledby={`${uid}-payments`}>
            <h2 id={`${uid}-payments`} className="pf-panel-title">
              Payments
            </h2>
            <PaymentList payments={payments} environment={environment} emptyText="This run records no payments." />
          </section>

          <section className="pf-panel" aria-labelledby={`${uid}-anchors`}>
            <h2 id={`${uid}-anchors`} className="pf-panel-title">
              Anchors
            </h2>
            <AnchorList anchors={anchors} environment={environment} />
          </section>
        </div>

        <div className="pf-col">
          <section className="pf-panel" aria-labelledby={`${uid}-summary`}>
            <h2 id={`${uid}-summary`} className="pf-panel-title">
              Summary
            </h2>
            <dl className="kv pf-kv">
              <dt>Run</dt>
              <dd>
                <code className="pf-code">{readText(pick(source, "run_id")) ?? runId}</code>
              </dd>
              <dt>Environment</dt>
              <dd>
                <EnvChip environment={environment} />
              </dd>
              <dt>Status</dt>
              <dd>
                <RunStatusChip status={status} />
              </dd>
              <dt>Scenario</dt>
              <dd>{readText(pick(source, "scenario")) ?? <NotProvided />}</dd>
              <dt>Supplier mode</dt>
              <dd>
                <SupplierModeChip mode={supplierMode} />
              </dd>
              <dt>Recorded</dt>
              <dd>{when(readText(pick(source, "created_at")))}</dd>
              <dt>Manifest</dt>
              <dd>
                {manifestId ? (
                  <Link className="link mono" to={`/verify/${encodeURIComponent(manifestId)}`}>
                    {manifestId}
                  </Link>
                ) : (
                  <NotProvided />
                )}
              </dd>
              <dt>Trip</dt>
              <dd>{tripId ? <code className="pf-code">{tripId}</code> : <NotProvided />}</dd>
            </dl>
          </section>

          <section className="pf-panel" aria-labelledby={`${uid}-limits`}>
            <h2 id={`${uid}-limits`} className="pf-panel-title">
              Limitations
            </h2>
            {limitations === undefined ? (
              <p className="pf-empty">No limitations were provided for this run. That does not mean it has none.</p>
            ) : limitations.length === 0 ? (
              <p className="pf-empty">The run lists no limitations.</p>
            ) : (
              <ul className="pf-bullets">
                {limitations.map((limitation, i) => (
                  <li key={`${i}-${limitation}`}>{limitation}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
