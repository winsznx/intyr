import type { ReactNode } from "react";
import { ArrowUpRight, Check, Clock3, Globe } from "lucide-react";
import { ApiError } from "../lib/api";
import { EVIDENCE_GRADE, humanize, type Tone } from "../lib/labels";
import { algoExplorerTx, formatDateTime } from "../lib/format";
import type { Environment, EvidenceGrade } from "../lib/types";
import { Chip, HashText, Notice, PaymentStateChip } from "./ui";

/*
 * Building blocks shared by the public proof pages (/verify, /evidence).
 * Every reader here takes `unknown`, because these pages render whatever the API
 * returned and must never fill a gap with a guess.
 */

export const NOT_PROVIDED = "Not provided";

export function NotProvided() {
  return <span className="pf-missing">{NOT_PROVIDED}</span>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pick(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "PAYMENT_SETTLED" becomes "Payment settled". Mixed-case text is only capitalized. */
export function labelFromCode(code: string): string {
  if (/^[A-Z0-9_]+$/.test(code)) return humanize(code).replace(/\.$/, "");
  return code.charAt(0).toUpperCase() + code.slice(1);
}

export function when(iso: string | undefined): string {
  return iso ? formatDateTime(iso) : NOT_PROVIDED;
}

const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
const FULL = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

function formatWith(format: Intl.DateTimeFormat, iso: string | undefined): string {
  if (!iso) return NOT_PROVIDED;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format.format(date);
}

/** "14:02:31 UTC" */
export function clockTime(iso: string | undefined): string {
  return formatWith(CLOCK, iso);
}

/** "30 Sept 2026, 14:02:31 UTC" */
export function fullTime(iso: string | undefined): string {
  return formatWith(FULL, iso);
}

/** "+0:07", "+12:40", "+1:02:03" from a millisecond offset. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `+${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `+${minutes}:${seconds}`;
}

const MAINNET_GENESIS = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const TESTNET_GENESIS = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

/** Resolves MAINNET, TESTNET, lower-case names and CAIP-2 ids. Anything else stays unknown. */
export function environmentOf(network: unknown): Environment | undefined {
  if (typeof network !== "string") return undefined;
  const value = network.trim();
  if (value.toUpperCase() === "MAINNET" || value.includes(MAINNET_GENESIS)) return "MAINNET";
  if (value.toUpperCase() === "TESTNET" || value.includes(TESTNET_GENESIS)) return "TESTNET";
  return undefined;
}

export function networkName(network: unknown): string {
  const env = environmentOf(network);
  if (env === "MAINNET") return "Algorand MainNet";
  if (env === "TESTNET") return "Algorand TestNet";
  return readText(network) ?? NOT_PROVIDED;
}

export function EnvChip({ environment }: { environment: unknown }) {
  const env = environmentOf(environment);
  if (!env) return <NotProvided />;
  return (
    <Chip tone={env === "MAINNET" ? "info" : "neutral"} enumStyle icon={<Globe aria-hidden />} title={networkName(env)}>
      {env}
    </Chip>
  );
}

/** Links only when the network is known, so a TestNet id never opens on the MainNet explorer. */
export function ExplorerLink({ txid, network }: { txid: string; network: unknown }) {
  const env = environmentOf(network);
  if (!env) return <span className="meta">Explorer link needs the network, which was not provided.</span>;
  return (
    <a className="pf-ext" href={algoExplorerTx(txid, env)} target="_blank" rel="noreferrer">
      Open in explorer
      <ArrowUpRight aria-hidden />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export interface AnchorView {
  txid?: string;
  round?: number;
  network?: string;
  mode?: string;
  confirmed?: boolean;
}

/** Accepts both the UI contract (`round`) and the signed payload form (`confirmed_round`). */
export function readAnchors(value: unknown): AnchorView[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((a) => ({
    txid: readText(a.txid),
    round: readNumber(a.round) ?? readNumber(a.confirmed_round),
    network: readText(a.network),
    mode: readText(a.mode),
    confirmed: typeof a.confirmed === "boolean" ? a.confirmed : undefined,
  }));
}

function AnchorState({ anchor }: { anchor: AnchorView }) {
  if (anchor.round !== undefined || anchor.confirmed === true) {
    return (
      <Chip tone="success" icon={<Check aria-hidden />}>
        Confirmed on chain
      </Chip>
    );
  }
  if (anchor.confirmed === false) {
    return (
      <Chip tone="unknown" icon={<Clock3 aria-hidden />}>
        Not confirmed yet
      </Chip>
    );
  }
  return null;
}

export function AnchorList({ anchors, environment }: { anchors: AnchorView[]; environment?: unknown }) {
  if (anchors.length === 0) {
    return <p className="pf-empty">No anchor was provided for this record.</p>;
  }
  return (
    <ul className="pf-list">
      {anchors.map((anchor, i) => {
        const network = anchor.network ?? environment;
        return (
          <li key={anchor.txid ?? `anchor-${i}`} className="pf-item">
            <div className="pf-item-head">
              <span className="pf-item-title">{anchors.length > 1 ? `Anchor ${i + 1}` : "Anchor"}</span>
              <AnchorState anchor={anchor} />
            </div>
            <dl className="kv pf-kv">
              <dt>Transaction</dt>
              <dd>{anchor.txid ? <HashText value={anchor.txid} label="anchor transaction id" /> : <NotProvided />}</dd>
              <dt>Round</dt>
              <dd className="mono num">{anchor.round ?? <NotProvided />}</dd>
              <dt>Network</dt>
              <dd>{networkName(network)}</dd>
              <dt>Mode</dt>
              <dd>{anchor.mode ? <code className="pf-code">{anchor.mode}</code> : <NotProvided />}</dd>
            </dl>
            {anchor.txid ? <ExplorerLink txid={anchor.txid} network={network} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function isEvidenceGrade(value: string): value is EvidenceGrade {
  return Object.hasOwn(EVIDENCE_GRADE, value);
}

const PRODUCTION_RANK = 3;
const GRADE_RANK: Record<EvidenceGrade, number> = {
  SIMULATED: 0,
  CALLER_ASSERTED: 1,
  SUPPLIER_SANDBOX: 2,
  SUPPLIER_PRODUCTION: PRODUCTION_RANK,
  SUPPLIER_SIGNED: 4,
};

/** A grade the page does not recognize counts as below production: nothing proves it live. */
export function isBelowProduction(grade: string): boolean {
  return !isEvidenceGrade(grade) || GRADE_RANK[grade] < PRODUCTION_RANK;
}

export function GradeChips({ grades }: { grades: string[] }) {
  if (grades.length === 0) return <NotProvided />;
  return (
    <span className="pf-chips">
      {grades.map((grade) => {
        const known = isEvidenceGrade(grade) ? EVIDENCE_GRADE[grade] : undefined;
        return (
          <Chip key={grade} tone={known?.tone ?? "amber"} title={grade}>
            {known?.label ?? labelFromCode(grade)}
          </Chip>
        );
      })}
    </span>
  );
}

export function SupplierScopeBanner({ children }: { children?: ReactNode }) {
  return (
    <Notice kind="review" title="Suppliers in this record are sandbox or simulated.">
      {children ?? "No leg in it was booked with a live supplier. Payments and chain anchors are checked separately from supplier data."}
    </Notice>
  );
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function isNotAvailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 503 || error.code === "NOT_AVAILABLE");
}

export interface RunEventView {
  at?: string;
  time?: number;
  type?: string;
  detail?: string;
  hash?: string;
  index: number;
}

/** Oldest first. Events without a readable time keep their original order after the timed ones. */
export function orderEvents(events: unknown): RunEventView[] {
  if (!Array.isArray(events)) return [];
  const rows = events.filter(isRecord).map((event, index): RunEventView => {
    const at = readText(event.at);
    const time = at ? Date.parse(at) : Number.NaN;
    return {
      at,
      time: Number.isNaN(time) ? undefined : time,
      type: readText(event.type),
      detail: readText(event.detail),
      hash: readText(event.hash),
      index,
    };
  });
  return rows.sort((a, b) => (a.time ?? Number.POSITIVE_INFINITY) - (b.time ?? Number.POSITIVE_INFINITY) || a.index - b.index);
}

export function EventType({ type }: { type: string | undefined }) {
  if (!type) return <span className="pf-missing">Event type not provided</span>;
  return (
    <span className="pf-event-type">
      <span>{labelFromCode(type)}</span>
      <code className="pf-code">{type}</code>
    </span>
  );
}

export function SupplierModeChip({ mode }: { mode: string | undefined }) {
  if (!mode) return <NotProvided />;
  if (isEvidenceGrade(mode)) {
    const grade = EVIDENCE_GRADE[mode];
    return (
      <Chip tone={grade.tone} title={mode}>
        {grade.label}
      </Chip>
    );
  }
  return (
    <Chip tone="neutral" enumStyle>
      {mode}
    </Chip>
  );
}

/** Supplier modes the run itself names as sandbox or simulated. */
export function isSandboxMode(mode: string | undefined): boolean {
  if (!mode) return false;
  if (isEvidenceGrade(mode)) return isBelowProduction(mode);
  return /SIM|SANDBOX|TEST/i.test(mode);
}

/* Payments */

export const SPONSORED_LABEL = "Sandbox: payment sponsored, no USDC moved";

/** USDC ASA ids on Algorand MainNet and TestNet. */
const USDC_ASSETS = new Set(["31566704", "10458941"]);

const PAYER_CLASS: Record<string, { label: string; tone: Tone }> = {
  EXTERNAL_ANON: { label: "External payer", tone: "outline" },
  EXTERNAL_ORG: { label: "External organization", tone: "outline" },
  INTERNAL_VALIDATION: { label: "Team validation payment", tone: "amber" },
  SANDBOX: { label: "Sandbox payer", tone: "neutral" },
};

export interface PaymentView {
  txid?: string;
  amount?: string;
  network?: string;
  payerClass?: string;
  state?: string;
  route?: string;
}

/** Exact decimal text for an integer amount in base units, with no float rounding. */
function fromBaseUnits(minor: number, digits: number): string {
  const text = String(Math.abs(Math.trunc(minor))).padStart(digits + 1, "0");
  const fraction = text.slice(-digits).replace(/0+$/, "");
  return `${minor < 0 ? "-" : ""}${text.slice(0, -digits)}${fraction ? `.${fraction}` : ""}`;
}

function amountOf(payment: Record<string, unknown>): string | undefined {
  const given = readText(payment.amount);
  if (given) return given;
  const minor = readNumber(payment.amount_minor);
  if (minor === undefined) return undefined;
  const asset = typeof payment.asset_id === "number" || typeof payment.asset_id === "string" ? String(payment.asset_id) : undefined;
  if (asset && USDC_ASSETS.has(asset)) return `${fromBaseUnits(minor, 6)} USDC`;
  return `${minor} base units${asset ? ` of asset ${asset}` : ""}`;
}

/** Reads the evidence form (`amount`, `payment_state`) and the signed manifest form (`amount_minor`, `asset_id`, `state`). */
export function readPayments(value: unknown): PaymentView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((payment) => ({
    txid: readText(payment.txid),
    amount: amountOf(payment),
    network: readText(payment.network),
    payerClass: readText(payment.payer_class),
    state: readText(payment.payment_state) ?? readText(payment.state),
    route: readText(payment.route),
  }));
}

export function PaymentList({ payments, environment, emptyText }: { payments: PaymentView[] | undefined; environment?: unknown; emptyText: string }) {
  if (payments === undefined) return <p className="pf-empty">No payment list was provided.</p>;
  if (payments.length === 0) return <p className="pf-empty">{emptyText}</p>;
  return (
    <ul className="pf-list">
      {payments.map((payment, i) => {
        const sponsored = payment.state === "SPONSORED";
        const network = payment.network ?? environment;
        const env = environmentOf(network);
        const payer = payment.payerClass ? PAYER_CLASS[payment.payerClass] : undefined;
        let amount: ReactNode = payment.amount ?? <NotProvided />;
        if (sponsored) amount = "No USDC moved";
        else if (payment.amount && env === "TESTNET") amount = `${payment.amount}, TestNet with no real value`;
        return (
          <li key={payment.txid ?? `payment-${i}`} className="pf-item">
            <div className="pf-item-head">
              <span className="pf-item-title">{payment.route ? <code className="pf-code">{payment.route}</code> : `Payment ${i + 1}`}</span>
              {sponsored ? (
                <Chip tone="neutral" title="SPONSORED">
                  {SPONSORED_LABEL}
                </Chip>
              ) : payment.state ? (
                <PaymentStateChip state={payment.state} />
              ) : null}
            </div>
            <dl className="kv pf-kv">
              <dt>Amount</dt>
              <dd>{amount}</dd>
              <dt>Transaction</dt>
              <dd>
                {payment.txid ? (
                  <HashText value={payment.txid} label="payment transaction id" />
                ) : sponsored ? (
                  <span className="pf-missing">None. A sponsored sandbox fee has no chain transaction.</span>
                ) : (
                  <NotProvided />
                )}
              </dd>
              <dt>Network</dt>
              <dd>{networkName(network)}</dd>
              <dt>Payer class</dt>
              <dd>
                {payment.payerClass ? (
                  <Chip tone={payer?.tone ?? "neutral"} title={payment.payerClass}>
                    {payer?.label ?? labelFromCode(payment.payerClass)}
                  </Chip>
                ) : (
                  <NotProvided />
                )}
              </dd>
            </dl>
            {payment.txid && !sponsored ? <ExplorerLink txid={payment.txid} network={network} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
