import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { LivePriceTable, useLivePrices } from "../../components/landing-prices";
import { CopyField, DecisionChip, Notice } from "../../components/ui";
import { DECISION } from "../../lib/labels";
import type { DecisionOutcome } from "../../lib/types";

const SECTIONS = [
  { id: "base-url", label: "Base URL" },
  { id: "discovery", label: "Discovery files" },
  { id: "first-call", label: "Ask for a check" },
  { id: "pay", label: "Pay with TypeScript" },
  { id: "payment-state", label: "Read the payment" },
  { id: "decisions", label: "Decision outcomes" },
  { id: "verify", label: "Verify a receipt" },
  { id: "prices", label: "Paid routes and prices" },
] as const;

/** Mainnet values from apps/api/src/config.ts. The /v1 challenge carries these. */
const MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const MAINNET_USDC = "31566704";
const TESTNET_USDC = "10458941";

const DISCOVERY = [
  { path: "/.well-known/x402", text: "Every paid route with its network, asset, amount and payTo, in x402 version 2 form." },
  { path: "/llms.txt", text: "A plain-text summary for language models: the routes, their prices and the rules an agent should follow." },
  { path: "/openapi.json", text: "OpenAPI 3.1 for the paid routes, including the 202, 402 and 409 answers." },
];

const AGENT_ACTION: Record<DecisionOutcome, string> = {
  ACT: "Go on to the next action the response allows.",
  NO_ACTION: "Nothing to do. Do not call again for the same state.",
  UNKNOWN: "Do not retry. Poll the operation or the trip until it resolves.",
  REFUSE: "Read reason_codes and change the request before calling again.",
  MANUAL_REVIEW: "Stop. /v1 has no approval route in this release, so the trip cannot be committed there. In the sandbox, a person approves it in the browser session.",
};

const OUTCOMES: DecisionOutcome[] = ["ACT", "NO_ACTION", "UNKNOWN", "REFUSE", "MANUAL_REVIEW"];

function isoFromNow(ms: number, now: number): string {
  return new Date(now + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A body for POST /v1/trips/check whose clocks sit a few hours after the moment the page loaded. */
function exampleTrip(now: number): string {
  const hours = (n: number) => isoFromNow(n * 3_600_000, now);
  return `{
  "trip_ref": "lisbon-weekend",
  "currency": "USD",
  "legs": [
    {
      "leg_id": "hotel-1", "type": "HOTEL",
      "supplier": "example-hotels", "offer_ref": "hotel-offer-123",
      "price": { "amount_minor": 41000, "currency": "USD" },
      "preparation_mode": "SOFT_HOLD", "refundable": true,
      "clocks": {
        "price_valid_until": "${hours(6)}",
        "free_cancel_until": "${hours(24 * 7)}"
      }
    },
    {
      "leg_id": "transfer-1", "type": "GROUND",
      "supplier": "example-transfers", "offer_ref": "transfer-offer-456",
      "price": { "amount_minor": 6500, "currency": "USD" },
      "preparation_mode": "REVALIDATED", "refundable": true,
      "clocks": { "price_valid_until": "${hours(6)}" }
    },
    {
      "leg_id": "flight-1", "type": "FLIGHT",
      "supplier": "example-airline", "offer_ref": "flight-offer-789",
      "price": { "amount_minor": 52000, "currency": "USD" },
      "preparation_mode": "INSTANT_COMMIT_ONLY", "refundable": false,
      "clocks": { "price_valid_until": "${hours(6)}" }
    }
  ],
  "limits": { "max_total_minor": 110000, "max_irreversible_minor": 60000 }
}`;
}

/** Mutes comment lines and marks HTTP status lines, 4xx in amber. Everything else renders as typed. */
function highlight(text: string): ReactNode[] {
  return text.split("\n").map((line, index, all) => {
    const end = index < all.length - 1 ? "\n" : "";
    if (/^\s*(#|\/\/)/.test(line)) {
      return (
        <span key={index} className="c-mute">
          {line}
          {end}
        </span>
      );
    }
    if (line.startsWith("HTTP/")) {
      return (
        <span key={index} className={/^HTTP\/\S+ 4\d\d/.test(line) ? "c-warn" : "c-key"}>
          {line}
          {end}
        </span>
      );
    }
    return line + end;
  });
}

function Code({ label, text }: { label: string; text: string }) {
  return (
    <pre className="codeblock qs-code" tabIndex={0} role="region" aria-label={label}>
      <code>{highlight(text)}</code>
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="qs-section" id={id} aria-labelledby={`${id}-title`}>
      <h2 className="title-m" id={`${id}-title`}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function QuickstartPage() {
  const prices = useLivePrices();
  const origin = window.location.origin;
  const trip = useMemo(() => exampleTrip(Date.now()), []);

  const curl = `curl -i -X POST "${origin}/v1/trips/check" \\
  -H "content-type: application/json" \\
  --data @trip.json`;

  const challenge = `HTTP/2 402
content-type: application/json
cache-control: no-store
payment-required: <base64 JSON>
x-intyr-body-hash: sha256:<hash of your body>

{}`;

  const decoded = `// payment-required, decoded and trimmed to what an agent needs
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "${origin}/v1/trips/check",
    "serviceName": "Intyr",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "${MAINNET_CAIP2}",
      "asset": "${MAINNET_USDC}",
      "amount": "<route price in USDC base units>",
      "payTo": "<pay_to from /v1/prices>",
      "maxTimeoutSeconds": 300,
      "extra": { "tag": "x402-global-challenge" }
    }
  ]
}`;

  const install = "npm install @x402/fetch @x402/avm";

  const typescript = `import { readFile } from "node:fs/promises";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactAvmScheme, toClientAvmSigner } from "@x402/avm";

// Base64 of the 64-byte Algorand secret key: the seed, then the public key.
const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!);

const payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "algorand:*", client: new ExactAvmScheme(signer) }],
  // The client refuses to sign any single payment above this.
  spendControls: { maxAmountPerPayment: "$1" },
});

const res = await payingFetch("${origin}/v1/trips/check", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: await readFile("trip.json", "utf8"),
});
const result = await res.json();

console.log(res.status, result.payment_state, result.payment_txid);

if (result.payment_state === "UNKNOWN") {
  // Paid but not confirmed yet. Do not call payingFetch again.
  // Poll GET /v1/payments/{payment_session_id} instead.
}`;

  const paid = `HTTP/2 200
{
  "trip_id": "trp_…",
  "state": "CHECKED",
  "plan_id": "…",
  "verdict": "COMMIT_NOW",
  "decision": { "outcome": "ACT", "reason_codes": ["…"] },
  "next_actions": [ … ],
  "plan": { "payload": { … }, "payload_hash": "sha256:…", "signature": { … } },
  "anchor": { "state": "…", "txid": "…", "mode": "…" },
  "operation_id": "…",
  "payment_state": "SETTLED",
  "payment_txid": "…",
  "payment_session_id": "…",
  "payment_explorer_url": "https://allo.info/tx/…"
}`;

  const poll = `curl "${origin}/v1/payments/<payment_session_id>"

{
  "payment_session_id": "…",
  "payment_state": "CONFIRMED",
  "payment_txid": "…",
  "explorer_url": "https://allo.info/tx/…",
  "operation_id": "…"
}`;

  const verify = `curl -X POST "${origin}/v1/manifests/verify" \\
  -H "content-type: application/json" \\
  -d '{ "manifest_id": "<manifest_id>" }'`;

  return (
    <div className="container qs">
      <header className="qs-head">
        <span className="badge">API quickstart</span>
        <h1 className="h2">Make your first paid call to Intyr</h1>
        <p className="body-l">
          Every paid route answers 402 with an x402 challenge. Your agent pays it in USDC on Algorand and sends the same request again. Reading prices,
          payments and receipts is free.
        </p>
      </header>

      <div className="qs-layout">
        <nav className="qs-toc" aria-label="On this page">
          <p className="qs-toc-label">On this page</p>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="qs-body">
          <Section id="base-url" title="Base URL">
            <p>
              The API is served from the same host as this page. Paths under <code>/v1</code> are paid in USDC on Algorand Mainnet. Paths under{" "}
              <code>/sandbox/v1</code> answer the same 402 on Algorand TestNet and take TestNet USDC, so use them while you build. Only{" "}
              <code>/v1</code> charges real USDC.
            </p>
            <CopyField value={origin} label="base URL" />
            <dl className="qs-networks">
              <div>
                <dt>
                  <code>/v1</code>
                </dt>
                <dd>
                  Algorand Mainnet. USDC is asset <span className="mono">{MAINNET_USDC}</span>.
                </dd>
              </div>
              <div>
                <dt>
                  <code>/sandbox/v1</code>
                </dt>
                <dd>
                  Algorand TestNet. USDC is asset <span className="mono">{TESTNET_USDC}</span>. The routes and bodies are the same. Calls made from
                  this site's sandbox session are sponsored: they come back with <code>payment_state</code> <code>SPONSORED</code> and move no USDC.
                </dd>
              </div>
            </dl>
          </Section>

          <Section id="discovery" title="Discovery files">
            <p>An agent can find every paid route without reading this page.</p>
            <ul className="qs-links">
              {DISCOVERY.map((d) => (
                <li key={d.path}>
                  <a className="link mono" href={d.path}>
                    {d.path}
                  </a>
                  <span>{d.text}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="first-call" title="Ask for a check">
            <p>
              <code>POST /v1/trips/check</code> takes legs your agent already found and returns a commit order and a verdict. Nothing is booked. Save a
              body like this as <code>trip.json</code>. Its clocks are set a few hours after this page loaded, so it stays valid while you try it.
            </p>
            <Code label="trip.json" text={trip} />
            <p>Send it without paying first.</p>
            <Code label="curl request" text={curl} />
            <p>
              An unpaid request gets 402 whatever its body. Intyr validates the body on the paid retry, before it settles the payment: a body that
              fails gets 422 with <code>charged: false</code>, and the payment is not settled.
            </p>
            <Code label="402 response" text={challenge} />
            <p>
              The body is empty. The challenge is the <code>payment-required</code> header, base64-encoded JSON.
            </p>
            <Code label="Decoded payment-required header" text={decoded} />
            <p>
              <code>amount</code> is the route price from the{" "}
              <a className="link" href="#prices">
                price list
              </a>{" "}
              in USDC base units. USDC has six decimals, so 1 USDC is 1000000. On <code>/sandbox/v1</code> the network is Algorand TestNet and the
              asset is <span className="mono">{TESTNET_USDC}</span>.
            </p>
          </Section>

          <Section id="pay" title="Pay with TypeScript">
            <p>
              The x402 fetch wrapper answers the 402 for you. It signs a USDC transfer for the exact amount, sends the same request again with a{" "}
              <code>payment-signature</code> header and returns the paid response. Written against <code>@x402/fetch</code> and{" "}
              <code>@x402/avm</code> 2.28.0.
            </p>
            <Code label="Install" text={install} />
            <Code label="TypeScript client" text={typescript} />
            <p>
              The paying account needs ALGO for its minimum balance, an opt-in to the USDC asset and enough USDC for the call. A paid check comes back
              like this.
            </p>
            <Code label="Paid response" text={paid} />
          </Section>

          <Section id="payment-state" title="Read the payment">
            <p>Every paid response carries the payment fields next to the result.</p>
            <dl className="qs-fields">
              <div>
                <dt>
                  <code>payment_state</code>
                </dt>
                <dd>
                  Where your payment is. <code>SETTLED</code> and <code>CONFIRMED</code> mean it reached the ledger. <code>UNKNOWN</code> means it was
                  submitted and is not confirmed yet. <code>SPONSORED</code> means the sandbox covered the fee, <code>payment_txid</code> is null and
                  no USDC moved.
                </dd>
              </div>
              <div>
                <dt>
                  <code>payment_txid</code>
                </dt>
                <dd>The Algorand transaction id of your payment. Intyr stores it before it contacts the facilitator.</dd>
              </div>
              <div>
                <dt>
                  <code>payment_session_id</code>
                </dt>
                <dd>The id to poll while the payment is unresolved.</dd>
              </div>
              <div>
                <dt>
                  <code>operation_id</code>
                </dt>
                <dd>The work this payment bought. Sending the same payment proof again returns this operation, never a second one.</dd>
              </div>
            </dl>
            <Notice kind="unknown" title="If payment_state is UNKNOWN, do not pay again.">
              The response is 202 with status <code>PAYMENT_PENDING</code>. Poll <code>GET /v1/payments/{"{payment_session_id}"}</code>, or{" "}
              <code>/sandbox/v1/payments/{"{payment_session_id}"}</code> on TestNet, until it reads <code>CONFIRMED</code>. A second payment would be a
              second charge.
            </Notice>
            <Code label="Poll a payment" text={poll} />
            <ul className="qs-bullets">
              <li>
                <code>EXPIRED_UNSETTLED</code> means the payment never reached the ledger. Nothing was charged and you can pay again.
              </li>
              <li>
                <code>409 PAYMENT_BINDING_MISMATCH</code> means the proof was made for a different request. A payment covers one route and one exact
                body.
              </li>
              <li>
                <code>GET /v1/operations/{"{operation_id}"}</code> returns the result of work that is still running.
              </li>
            </ul>
          </Section>

          <Section id="decisions" title="Decision outcomes">
            <p>Each decision Intyr makes has one of five outcomes and reason codes that say why. Branch on the outcome.</p>
            <table className="qs-outcomes" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">
                    Outcome
                  </th>
                  <th role="columnheader" scope="col">
                    Meaning
                  </th>
                  <th role="columnheader" scope="col">
                    What your agent does
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {OUTCOMES.map((outcome) => (
                  <tr role="row" key={outcome}>
                    <td role="cell">
                      <DecisionChip outcome={outcome} />
                    </td>
                    <td role="cell">{DECISION[outcome].meaning}</td>
                    <td role="cell" className="qs-outcome-action">
                      {AGENT_ACTION[outcome]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section id="verify" title="Verify a receipt">
            <p>
              Checks, commits and recoveries each produce a manifest signed by Intyr, with its hash anchored on Algorand. For a check, the manifest id
              is <code>plan_id</code>. Anyone can verify one, with no account and no payment.
            </p>
            <Code label="Verify a manifest" text={verify} />
            <p>
              The answer has a <code>proof_state</code>, such as <code>PROOF_VERIFIED</code>, or <code>PROOF_PARTIAL</code> while the anchor is still
              confirming, and the list of checks it ran. <code>GET /v1/manifests/{"{manifest_id}"}</code> returns the signed manifest itself. People
              can paste the id into the{" "}
              <Link className="link" to="/verify">
                verifier
              </Link>{" "}
              instead.
            </p>
          </Section>

          <Section id="prices" title="Paid routes and prices">
            <p>
              Revalidate, commit and recover take the <code>trip_id</code> in the body. This list is read from the API when the page loads, from{" "}
              <code>/v1/prices</code> or, if that does not answer, from <code>/sandbox/v1/prices</code>.
            </p>
            <LivePriceTable prices={prices} />
          </Section>
        </div>
      </div>
    </div>
  );
}
