import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router";
import { BedDouble, Car, Check, Minus, Plane, RotateCcw, Send } from "lucide-react";
import { LivePriceTable, findRoute, formatUsdc, useLivePrices, type LivePrices } from "../../components/landing-prices";
import { LandingSteps } from "../../components/landing-steps";
import { TripRails } from "../../components/trip-rails";
import { ButtonLink, Chip, ComponentStateChip, TripStateChip } from "../../components/ui";
import type { TripComponent } from "../../lib/types";
import type { Resource } from "../../lib/use-resource";

const CAMPAIGN_RESULTS_URL = "https://github.com/winsznx/intyr/blob/main/evidence/campaign-001/RESULTS.md";

/** Illustrative trip for the hero frame. Captioned as an illustration, never presented as a live run. */
const EXAMPLE_TRIP: TripComponent[] = [
  {
    component_id: "example-hotel",
    type: "HOTEL",
    label: "Hotel",
    supplier: "LiteAPI",
    leg_class: "SUPPLIER_SANDBOX",
    evidence_grade: "SUPPLIER_SANDBOX",
    preparation_mode: "SOFT_HOLD",
    commit_order: 1,
    state: "CANCELLED",
  },
  {
    component_id: "example-transfer",
    type: "GROUND",
    label: "Airport transfer",
    leg_class: "SIMULATED",
    evidence_grade: "SIMULATED",
    preparation_mode: "REVALIDATED",
    commit_order: 2,
    state: "CANCELLED",
  },
  {
    component_id: "example-flight",
    type: "FLIGHT",
    label: "Flight",
    supplier: "Duffel",
    leg_class: "SUPPLIER_SANDBOX",
    evidence_grade: "SUPPLIER_SANDBOX",
    preparation_mode: "INSTANT_COMMIT_ONLY",
    commit_order: 3,
    irreversible: true,
    state: "COMMIT_FAILED",
  },
];

function shortNetwork(network: string): string {
  return network.length > 20 ? `${network.slice(0, 18)}…` : network;
}

/** The agent's side of the frame. Path, network, asset and amount come from the live price list. */
function HeroCall({ prices }: { prices: LivePrices | undefined }) {
  const check = prices ? findRoute(prices.table, "/trips/check") : undefined;
  const path = check?.path ?? "/v1/trips/check";
  const network = prices ? shortNetwork(prices.table.network) : "…";
  const asset = prices ? `USDC ${prices.table.asset}` : "…";
  const amount = check ? (check.price_atomic ? `${check.price_atomic} = ${formatUsdc(check.price_usdc)}` : formatUsdc(check.price_usdc)) : "…";

  return (
    <pre className="codeblock lp-frame-code" tabIndex={0} role="region" aria-label="Example agent call paid with x402">
      <code>
        <span className="c-mute"># The agent asks for a check</span>
        {"\n"}
        <span className="c-key">POST</span> {path}
        {"\n"}
        {'{ "currency": "USD", "legs": […] }'}
        {"\n\n"}
        <span className="c-warn">HTTP 402 Payment Required</span>
        {"\n"}
        payment-required: <span className="c-str">{"<challenge>"}</span>
        {"\n"}
        {"  scheme   exact\n"}
        {`  network  ${network}\n`}
        {`  asset    ${asset}\n`}
        {`  amount   ${amount}\n`}
        {"\n"}
        <span className="c-mute"># It pays, then sends it again</span>
        {"\n"}
        <span className="c-key">POST</span> {path}
        {"\n"}
        payment-signature: <span className="c-str">{"<USDC transfer>"}</span>
        {"\n\n"}
        <span className="c-key">HTTP 200 OK</span>
        {"\n"}
        {'{ "verdict": "COMMIT_NOW",\n'}
        {'  "payment_state": "SETTLED",\n'}
        {'  "payment_txid": "…" }'}
      </code>
    </pre>
  );
}

function Hero({ prices }: { prices: LivePrices | undefined }) {
  return (
    <section className="lp-hero" aria-labelledby="lp-hero-title">
      <div className="container">
        <div className="lp-hero-head">
          <span className="badge">For AI agents that book trips</span>
          <h1 className="display lp-hero-title" id="lp-hero-title">
            Book every part of the trip, or undo what can be undone.
          </h1>
          <p className="body-l lp-hero-sub">
            Intyr prepares each flight, hotel and transfer an AI agent wants, checks it before money moves, commits only inside the limits you set and
            runs the recovery you agreed to. When a leg cannot be undone, Intyr says so and shows what is still booked. Agents pay per action in USDC on
            Algorand through x402.
          </p>
          <div className="lp-hero-actions">
            <ButtonLink to="/app/demo" size="lg">
              Run a failing trip
            </ButtonLink>
            <ButtonLink to="/docs/quickstart" variant="secondary" size="lg">
              Call the API
            </ButtonLink>
          </div>
        </div>

        <figure className="lp-frame">
          <div className="lp-frame-grid">
            <div className="lp-frame-rails">
              <div className="lp-frame-card">
                <div className="lp-frame-card-head">
                  <div>
                    <p className="card-title">Example trip</p>
                    <p className="lp-frame-card-sub">
                      The flight failed after the hotel and transfer were booked, so Intyr cancelled both inside the limits set before payment.
                    </p>
                  </div>
                  <TripStateChip state="RECOVERED" />
                </div>
                <TripRails components={EXAMPLE_TRIP} />
              </div>
            </div>
            <HeroCall prices={prices} />
          </div>
          <figcaption className="lp-frame-caption">Illustration. Run the demo to see a live one on Algorand TestNet.</figcaption>
        </figure>
      </div>
    </section>
  );
}

interface SequenceRow {
  key: string;
  icon: ReactNode;
  name: string;
  status: ReactNode;
}

function Sequence({ rows, result }: { rows: SequenceRow[]; result: string }) {
  return (
    <div className="nested-card lp-sequence">
      <ol className="lp-legs">
        {rows.map((row, index) => (
          <li key={row.key} className="lp-leg">
            <span className="rail-order mono" aria-hidden>
              {index + 1}
            </span>
            <span className="rail-icon" aria-hidden>
              {row.icon}
            </span>
            <span className="lp-leg-name">
              <span className="lp-leg-title">{row.name}</span>
            </span>
            <span className="lp-leg-status">{row.status}</span>
          </li>
        ))}
      </ol>
      <p className="lp-sequence-result">{result}</p>
    </div>
  );
}

function Problem() {
  return (
    <section className="section" aria-labelledby="lp-problem-title">
      <div className="container">
        <div className="section-head">
          <div className="lp-head-main">
            <span className="badge">The problem</span>
            <h2 className="h2" id="lp-problem-title">
              One trip, several suppliers, no shared undo
            </h2>
          </div>
          <p className="body-l">
            An agent books each leg with a different supplier, one call at a time. Nothing ties those calls together, so a failure halfway through
            leaves the trip half bought.
          </p>
        </div>

        <div className="lp-two">
          <article className="soft-card lp-card">
            <h3 className="title-s">A failed flight strands a paid hotel</h3>
            <p className="body">The agent books the hotel first. Then the flight fails, and the traveller has a paid room and no way to reach it.</p>
            <Sequence
              rows={[
                { key: "hotel", icon: <BedDouble />, name: "Hotel", status: <ComponentStateChip state="CONFIRMED" /> },
                { key: "transfer", icon: <Car />, name: "Airport transfer", status: <ComponentStateChip state="CONFIRMED" /> },
                { key: "flight", icon: <Plane />, name: "Flight", status: <ComponentStateChip state="COMMIT_FAILED" /> },
              ]}
              result="The hotel and transfer stay paid for a trip that will not happen."
            />
          </article>

          <article className="soft-card lp-card">
            <h3 className="title-s">A timeout and a retry book twice</h3>
            <p className="body">The supplier is slow to answer, so the agent sends the booking again. The first request had already gone through.</p>
            <Sequence
              rows={[
                { key: "first", icon: <Send />, name: "Flight booking sent", status: <Chip tone="unknown">No reply</Chip> },
                { key: "retry", icon: <RotateCcw />, name: "Agent retries", status: <Chip tone="outline">Sent again</Chip> },
                { key: "result", icon: <Plane />, name: "Supplier", status: <Chip tone="danger">Two bookings</Chip> },
              ]}
              result="Both bookings are charged. Nobody read the supplier before the retry."
            />
          </article>
        </div>
        <p className="lp-footnote">
          These failures come from documented supplier behavior: lost responses, failures reported later, a reply that claims a booking that does not
          exist, and blind retries that book twice. The{" "}
          <a className="link" href={CAMPAIGN_RESULTS_URL} target="_blank" rel="noreferrer">
            campaign results
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>{" "}
          show a naive agent running into each of them in a seeded simulator.
        </p>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="section" id="how-it-works" aria-labelledby="lp-how-title">
      <div className="container">
        <div className="section-head">
          <div className="lp-head-main">
            <span className="badge">How it works</span>
            <h2 className="h2" id="lp-how-title">
              Check, prepare, commit, recover
            </h2>
          </div>
          <p className="body-l">
            Intyr gives an agent the commit and recovery behavior a careful engineer would write, as paid x402 calls, and matched such a script in
            ten of eleven campaign cells. Each step returns a decision the agent can branch on and a signed receipt.
          </p>
        </div>
        <LandingSteps />
      </div>
    </section>
  );
}

/** Figures from evidence/campaign-001/RESULTS.md. The claim is the narrowed one that document states, quoted as written. */
const CAMPAIGN_ARMS = [
  { name: "Naive agent", duplicates: "20", work: "3.6 supplier calls per trip", consistent: "36%" },
  { name: "Careful script", duplicates: "0", work: "8.7 supplier calls per trip, and 431 lines of the caller's own code", consistent: "100%" },
  { name: "Intyr", duplicates: "0", work: "2.9 calls to Intyr per trip", consistent: "92%" },
];

function Results() {
  return (
    <section className="section" aria-labelledby="lp-results-title">
      <div className="container">
        <div className="section-head">
          <div className="lp-head-main">
            <span className="badge">Measured</span>
            <h2 className="h2" id="lp-results-title">
              It matched a careful script in ten of eleven cells and lost one
            </h2>
          </div>
          <p className="body-l">
            Under ten documented supplier fault patterns, a naive agent leaves bookings stranded or duplicated in most runs. A careful engineer's script
            avoids that. Intyr provides the same careful behaviour as one paid call per step, 2.9 calls per trip from the caller's side, with signed
            manifests and decision records, and it matched that script in ten of eleven cells and lost one.
          </p>
        </div>

        <div className="lp-prices">
          <div className="lp-prices-head">
            <p className="lp-prices-title">Campaign 001, 110 runs per approach on the seeded simulator</p>
          </div>
          <div className="lp-prices-body">
            <table className="lp-price-table">
              <thead>
                <tr>
                  <th scope="col">Approach</th>
                  <th scope="col">Duplicate orders</th>
                  <th scope="col">Work for the caller</th>
                  <th scope="col" className="lp-pt-price">
                    Consistent end state
                  </th>
                </tr>
              </thead>
              <tbody>
                {CAMPAIGN_ARMS.map((arm) => (
                  <tr key={arm.name}>
                    <td className="lp-pt-call">
                      <span className="lp-pt-name">{arm.name}</span>
                    </td>
                    <td className="lp-pt-returns" data-label="Duplicate orders">
                      {arm.duplicates}
                    </td>
                    <td className="lp-pt-fee" data-label="Work for the caller">
                      {arm.work}
                    </td>
                    <td className="lp-pt-price" data-label="Consistent">
                      {arm.consistent}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="lp-prices-note">
            A consistent end state means every leg ended fully booked or fully unwound, as read from the simulator's own order list. The campaign was
            pre-registered in the repository before any run.
          </p>
        </div>

        <article className="soft-card lp-card lp-results-loss">
          <h3 className="title-s">The cell Intyr lost</h3>
          <p className="body">
            The hotel accepted the booking and then refused every cancellation, and the flight was refused. Nothing in either quote said the hotel could
            not be cancelled, so Intyr booked the cheaper hotel first. 9 of 10 runs ended <code>RECOVERY_FAILED</code> with the hotel still booked,
            and Intyr reported the stranded hotel each time. The script booked the flight first and stranded nothing.{" "}
            <a className="link" href={CAMPAIGN_RESULTS_URL} target="_blank" rel="noreferrer">
              Read the full results
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
            .
          </p>
        </article>
      </div>
    </section>
  );
}

function Proof() {
  return (
    <section className="section" aria-labelledby="lp-proof-title">
      <div className="container">
        <div className="section-head">
          <div className="lp-head-main">
            <span className="badge">Receipts</span>
            <h2 className="h2" id="lp-proof-title">
              Every outcome leaves a receipt anyone can check
            </h2>
          </div>
          <div className="lp-head-aside">
            <p className="body-l">
              Each outcome produces a manifest signed by Intyr. Its hash is anchored on Algorand, and anyone can check it at /verify without an
              account.
            </p>
            <ButtonLink to="/verify" variant="secondary">
              Verify a receipt
            </ButtonLink>
          </div>
        </div>

        <div className="lp-two">
          <article className="soft-card lp-card">
            <h3 className="title-s">What a receipt proves</h3>
            <ul className="lp-checklist">
              <li>
                <span className="lp-mark lp-mark-yes" aria-hidden>
                  <Check />
                </span>
                <span>
                  <span className="lp-check-lead">The record was not changed after it was signed.</span> The signature and the hash still match the
                  manifest you hold.
                </span>
              </li>
              <li>
                <span className="lp-mark lp-mark-yes" aria-hidden>
                  <Check />
                </span>
                <span>
                  <span className="lp-check-lead">When it was anchored.</span> The Algorand transaction that carries its hash fixes the round it
                  was recorded in.
                </span>
              </li>
            </ul>
          </article>

          <article className="soft-card lp-card">
            <h3 className="title-s">What it does not prove</h3>
            <ul className="lp-checklist">
              <li>
                <span className="lp-mark lp-mark-no" aria-hidden>
                  <Minus />
                </span>
                <span>
                  <span className="lp-check-lead">That the supplier's data was true.</span> Intyr records what each supplier returned and labels it
                  as test mode, simulated or reported by the agent.
                </span>
              </li>
              <li>
                <span className="lp-mark lp-mark-no" aria-hidden>
                  <Minus />
                </span>
                <span>
                  <span className="lp-check-lead">That a supplier will honour a booking.</span> A confirmation is the supplier's answer at the time
                  Intyr read it.
                </span>
              </li>
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

function Pricing({ prices }: { prices: Resource<LivePrices> }) {
  return (
    <section className="section" aria-labelledby="lp-pricing-title">
      <div className="container">
        <div className="section-head">
          <div className="lp-head-main">
            <span className="badge">Pricing</span>
            <h2 className="h2" id="lp-pricing-title">
              Pay per call in USDC
            </h2>
          </div>
          <p className="body-l">
            Agents pay each call over x402 on Algorand, with no account, API key or subscription. This list is read from the API as the page loads.
          </p>
        </div>
        <LivePriceTable prices={prices} />
      </div>
    </section>
  );
}

const LIMITS = [
  {
    lead: "Test-mode and simulated suppliers",
    text: "The demo failures run on a seeded simulator. Real Duffel and LiteAPI test offers score below the readiness bar, so a person approves them before Intyr commits. They are supplier test orders, not real travel.",
  },
  {
    lead: "No actual travel is booked",
    text: "Supplier calls run against test modes and the simulator, so no ticket, room or ride is issued to anyone.",
  },
  {
    lead: "Commit order is a tie-break",
    text: "When no leg is marked as impossible to undo, Intyr commits the leg that expires first, then the cheaper one. If that leg later refuses to cancel, it stays booked, and the trip ends RECOVERY_FAILED naming it.",
  },
  {
    lead: "No insurance or bond",
    text: "Assurance mode is none. Intyr lowers the chance and size of a partial booking and underwrites nothing when one happens.",
  },
  {
    lead: "Approvals stay in the sandbox session",
    text: "When a trip needs a person to approve it, the approval happens in the anonymous browser session that created it. There are no organization accounts yet.",
  },
];

function Limits() {
  return (
    <section className="section" aria-labelledby="lp-limits-title">
      <div className="container lp-limits">
        <div className="lp-head-main">
          <span className="badge">Limits of this release</span>
          <h2 className="h2" id="lp-limits-title">
            What this release does not do
          </h2>
        </div>
        <ul className="lp-limit-list">
          {LIMITS.map((limit) => (
            <li key={limit.lead}>
              <span className="lp-limit-lead">{limit.lead}</span>
              <span className="lp-limit-text">{limit.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FinalCall() {
  return (
    <section className="section" aria-labelledby="lp-final-title">
      <div className="container">
        <div className="soft-card lp-cta">
          <h2 className="h2" id="lp-final-title">
            Watch a trip fail and recover
          </h2>
          <p className="body-l">
            The demo runs a trip on Algorand TestNet against a seeded supplier failure and shows each step Intyr took, with its receipt.
          </p>
          <div className="lp-cta-actions">
            <ButtonLink to="/app/demo" size="lg">
              Run a failing trip
            </ButtonLink>
            <ButtonLink to="/docs/quickstart" variant="secondary" size="lg">
              Call the API
            </ButtonLink>
            <ButtonLink to="/verify" variant="secondary" size="lg">
              Verify a receipt
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Scrolls to the section named in the URL hash, since client-side navigation does not. */
function useScrollToHash() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" });
  }, [hash]);
}

export function LandingPage() {
  const prices = useLivePrices();
  useScrollToHash();
  return (
    <>
      <Hero prices={prices.data} />
      <Problem />
      <HowItWorks />
      <Results />
      <Proof />
      <Pricing prices={prices} />
      <Limits />
      <FinalCall />
    </>
  );
}
