import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleX,
  Clock3,
  FileSearch,
  FileText,
  KeyRound,
  Layers,
  Minus,
  WifiOff,
  X,
} from "lucide-react";
import { ApiError, PUBLIC, SANDBOX, api, type ApiErrorBody } from "../../lib/api";
import { COMPONENT_TYPE, PROOF_STATE, describeReason, type Tone } from "../../lib/labels";
import { shortId } from "../../lib/format";
import type { Environment, ProofState, VerifyResult } from "../../lib/types";
import { useResource } from "../../lib/use-resource";
import { Button, ButtonLink, Chip, CopyField, ErrorState, HashText, Notice, Ring, Skeleton, TripStateChip, cx } from "../../components/ui";
import {
  AnchorList,
  EnvChip,
  GradeChips,
  NotProvided,
  PaymentList,
  SupplierScopeBanner,
  environmentOf,
  isBelowProduction,
  isNotAvailable,
  isNotFound,
  isRecord,
  labelFromCode,
  networkName,
  pick,
  readAnchors,
  readPayments,
  readText,
  when,
  type AnchorView,
  type PaymentView,
} from "../../components/proof-parts";

const SIGNING_KEYS_PATH = "/.well-known/intyr-signing-keys.json";

export function VerifyPage() {
  const { manifestId } = useParams();
  return manifestId ? <ManifestProofPage key={manifestId} manifestId={manifestId} /> : <VerifyFormPage />;
}

/* ------------------------------------------------------------------ */
/* Reading the API responses                                           */
/* ------------------------------------------------------------------ */

type ManifestKind = "PLAN" | "COMMIT" | "TRANSACTION";

const KIND_ALIASES: Record<string, ManifestKind> = {
  PLAN: "PLAN",
  CommitPlan: "PLAN",
  "commit-plan/1": "PLAN",
  COMMIT: "COMMIT",
  CommitManifest: "COMMIT",
  "commit-manifest/1": "COMMIT",
  TRANSACTION: "TRANSACTION",
  TransactionManifest: "TRANSACTION",
  "transaction-manifest/1": "TRANSACTION",
};

const KIND_COPY: Record<ManifestKind, { noun: string; title: string; explain: string }> = {
  PLAN: {
    noun: "a commit plan",
    title: "Commit plan",
    explain: "Intyr's check of offers an agent brought, made before anything was booked.",
  },
  COMMIT: {
    noun: "a commit manifest",
    title: "Commit manifest",
    explain: "The trip terms an agent reviews and pays against before it commits.",
  },
  TRANSACTION: {
    noun: "the final record",
    title: "Transaction manifest",
    explain: "The final record of what was committed or recovered, with its payments and decisions.",
  },
};

interface LegView {
  id?: string;
  type?: string;
  supplier?: string;
  legClass?: string;
  grade?: string;
  /** SIMULATED, SANDBOX, TEST or LIVE, as signed into the payload. */
  supplierMode?: string;
  faults: string[];
}

interface ManifestView {
  id?: string;
  kind?: ManifestKind;
  rawKind?: string;
  environment?: Environment;
  createdAt?: string;
  expiresAt?: string;
  hash?: string;
  keyId?: string;
  signatureAlg?: string;
  signatureContext?: string;
  status?: string;
  supersededBy?: string;
  supersedes?: string;
  tripId?: string;
  finalState?: string;
  anchors: AnchorView[];
  grades: string[];
  legs: LegView[];
  payments?: PaymentView[];
  assurance?: string;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => v !== undefined))];
}

function readLegs(components: unknown): LegView[] {
  if (!Array.isArray(components)) return [];
  return components.filter(isRecord).map((c) => {
    const faults: unknown[] = Array.isArray(c.synthetic_faults) ? c.synthetic_faults : [];
    return {
      id: readText(c.component_id) ?? readText(c.leg_id),
      type: readText(c.type),
      supplier: readText(c.supplier),
      legClass: readText(c.leg_class),
      grade: readText(c.evidence_grade),
      supplierMode: readText(c.supplier_mode),
      faults: unique(faults.map((f) => readText(pick(f, "fault")) ?? readText(f))),
    };
  });
}

function readManifestPayments(payload: unknown): PaymentView[] | undefined {
  const inbound = readPayments(pick(payload, "inbound_payments"));
  const outbound = readPayments(pick(payload, "outbound_payments"));
  if (!inbound && !outbound) return undefined;
  return [...(inbound ?? []), ...(outbound ?? [])];
}

/**
 * The API serves `{ manifest_id, kind, status, hash, expires_at, signed: { payload, payload_hash,
 * signature } }`, and the payload is the signed document. Where that differs from
 * `ManifestDocument` in lib/types, the served shape wins. Signed facts (environment, legs,
 * supplier modes) come from the payload. A bare signed document someone pasted reads the same.
 */
function readManifest(source: unknown): ManifestView {
  const signed = pick(source, "signed");
  const payload = pick(signed, "payload") ?? pick(source, "payload");
  const signature = pick(signed, "signature") ?? pick(source, "signature");
  const rawKind = readText(pick(source, "kind")) ?? readText(pick(payload, "schema_version"));
  const legs = readLegs(pick(payload, "components") ?? pick(payload, "legs"));
  const grades = unique(legs.map((leg) => leg.grade));
  const banner = readText(pick(payload, "evidence_banner"));
  const ownAnchors = readAnchors(pick(source, "anchors"));
  return {
    id: readText(pick(source, "manifest_id")) ?? readText(pick(payload, "manifest_id")) ?? readText(pick(payload, "plan_id")),
    kind: rawKind ? KIND_ALIASES[rawKind] : undefined,
    rawKind,
    environment: environmentOf(pick(payload, "environment")) ?? environmentOf(pick(source, "environment")),
    createdAt: readText(pick(payload, "created_at")) ?? readText(pick(source, "created_at")),
    expiresAt: readText(pick(source, "expires_at")) ?? readText(pick(payload, "expires_at")) ?? readText(pick(payload, "valid_until")),
    hash:
      readText(pick(source, "manifest_hash")) ??
      readText(pick(source, "hash")) ??
      readText(pick(source, "payload_hash")) ??
      readText(pick(signed, "payload_hash")),
    keyId: readText(pick(signature, "key_id")),
    signatureAlg: readText(pick(signature, "alg")),
    signatureContext: readText(pick(signature, "context")),
    status: readText(pick(source, "status")) ?? readText(pick(source, "status_record", "status")),
    supersededBy: readText(pick(source, "superseded_by")) ?? readText(pick(source, "status_record", "superseded_by")),
    supersedes: readText(pick(source, "supersedes")) ?? readText(pick(payload, "supersedes")),
    tripId: readText(pick(payload, "trip_id")) ?? readText(pick(payload, "trip_ref")),
    finalState: readText(pick(payload, "final_state")),
    anchors: ownAnchors.length > 0 ? ownAnchors : readAnchors(pick(payload, "anchors")),
    grades: grades.length === 0 && banner && banner !== "NONE" ? [banner] : grades,
    legs,
    payments: readManifestPayments(payload),
    assurance: readText(pick(payload, "assurance", "mode")),
  };
}

function errorBody(body: unknown): ApiErrorBody {
  const codes = pick(body, "reason_codes");
  return {
    error: readText(pick(body, "error")),
    message: readText(pick(body, "message")),
    reason_codes: Array.isArray(codes) ? unique(codes.map(readText)) : undefined,
  };
}

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: "application/json" }, credentials: "same-origin", signal });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, {}, "The Intyr API could not be reached.");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(response.status, errorBody(body), `Request failed with status ${response.status}.`);
  if (body === undefined) throw new ApiError(response.status, { error: "INVALID_RESPONSE" }, "The API returned a response the page could not read.");
  return body;
}

interface LoadedManifest {
  doc: unknown;
  /** The path that answered, so the raw JSON link opens the same record. */
  path: string;
}

/** /v1 first. A TestNet sandbox manifest may only resolve under /sandbox/v1. */
async function loadManifest(manifestId: string, signal: AbortSignal): Promise<LoadedManifest> {
  const id = encodeURIComponent(manifestId);
  try {
    return { doc: await api.getManifest(manifestId, signal), path: `${PUBLIC}/manifests/${id}` };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const path = `${SANDBOX}/manifests/${id}`;
  return { doc: await getJson(path, signal), path };
}

interface CheckView {
  name?: string;
  status?: string;
  detail?: string;
}

interface VerifyView {
  proofState?: string;
  /** Undefined when the response carried no list at all, which differs from an empty list. */
  checks?: CheckView[];
  anchors: AnchorView[];
  grades: string[];
  environment?: Environment;
  hash?: string;
  manifestId?: string;
  verifiedAt?: string;
  indexer?: string;
}

function readVerify(result: VerifyResult | undefined): VerifyView | undefined {
  if (!result) return undefined;
  const source: unknown = result;
  const checks = pick(source, "checks");
  const checked = pick(source, "checked");
  const grades = pick(source, "evidence_grades");
  const proofState = readText(pick(source, "proof_state"));
  const anchor = pick(source, "anchor");
  const anchorState = isRecord(anchor) ? readText(anchor.state) : undefined;
  const integrity = readText(pick(source, "integrity"));
  return {
    proofState,
    checks: Array.isArray(checks)
      ? checks.filter(isRecord).map((c) => ({ name: readText(c.check), status: readText(c.status), detail: readText(c.detail) }))
      : Array.isArray(checked)
        ? checked.map(readText).filter((name): name is string => Boolean(name)).map((name) => namedCheck(name, proofState, integrity, anchorState))
        : undefined,
    anchors: readAnchors(pick(source, "anchors")).concat(isRecord(anchor) && readText(anchor.txid) ? readAnchors([anchor]) : []),
    grades: Array.isArray(grades) ? unique(grades.map(readText)) : [],
    environment: environmentOf(pick(source, "environment")),
    hash: readText(pick(source, "manifest_hash")),
    manifestId: readText(pick(source, "manifest_id")),
    verifiedAt: readText(pick(source, "verified_at")),
    indexer: readText(pick(source, "indexer")),
  };
}

const CHECK_NAMES: Record<string, string> = {
  payload_hash: "The payload hashes to the recorded hash",
  signature: "Signed by a published Intyr key",
  component_root: "The component root matches the legs",
  anchor_note: "The hash is anchored in an Algorand transaction note",
};

/** The live verifier lists the checks it ran by name. Their result follows from integrity and the anchor state. */
function namedCheck(name: string, proofState: string | undefined, integrity: string | undefined, anchorState: string | undefined): CheckView {
  if (name === "anchor_note") {
    if (proofState === "PROOF_VERIFIED") return { name: CHECK_NAMES[name], status: "PASS" };
    if (anchorState === "ANCHOR_UNCONFIRMED") return { name: CHECK_NAMES[name], status: "PENDING", detail: "Submitted, not confirmed yet." };
    return { name: CHECK_NAMES[name], status: "FAIL", detail: anchorState === "ANCHOR_NOT_FOUND" ? "No anchor transaction was found for this record." : anchorState };
  }
  const status = integrity === "VALID" ? "PASS" : integrity ? "FAIL" : undefined;
  return { name: CHECK_NAMES[name] ?? name, status };
}

function isProofState(value: string): value is ProofState {
  return Object.hasOwn(PROOF_STATE, value);
}

/** One sentence: what the record is, where it lives, when it was issued. It never says the record is valid. */
function claimSentence(view: ManifestView): string {
  const what = view.kind ? KIND_COPY[view.kind].noun : "an Intyr manifest";
  const trip = view.tripId ? ` for trip ${shortId(view.tripId, 8, 4)}` : "";
  const network = view.environment ? ` on ${networkName(view.environment)}` : "";
  const issued = view.createdAt ? `, issued ${when(view.createdAt)}` : "";
  return `This record is ${what}${trip}${network}${issued}.`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function verifyCommand(body: string, base: string = PUBLIC): string {
  return `curl -s -X POST ${window.location.origin}${base}/manifests/verify -H 'content-type: application/json' -d ${shellQuote(body)}`;
}

/* ------------------------------------------------------------------ */
/* /verify/:manifestId                                                 */
/* ------------------------------------------------------------------ */

function ManifestProofPage({ manifestId }: { manifestId: string }) {
  const manifest = useResource(`manifest:${manifestId}`, (signal) => loadManifest(manifestId, signal));
  const verification = useResource(`verify:${manifestId}`, () => api.verifyAnywhere({ manifest_id: manifestId }));
  const view = readManifest(manifest.data?.doc);
  const rawHref = manifest.data?.path ?? `${PUBLIC}/manifests/${encodeURIComponent(manifestId)}`;

  if (!manifest.loaded) {
    return (
      <div className="container section-tight pf-page">
        <BackToVerifier />
        <div className="pf-head" role="status" aria-busy="true">
          <span className="visually-hidden">Loading manifest {manifestId}</span>
          <Skeleton width={180} height={14} />
          <Skeleton width="min(760px, 100%)" height={36} />
          <Skeleton width="min(520px, 80%)" height={36} />
        </div>
        <div className="pf-skel-panel" aria-hidden>
          <Skeleton height={96} />
        </div>
      </div>
    );
  }

  if (manifest.error && isNotFound(manifest.error)) {
    return (
      <div className="container section-tight pf-page">
        <BackToVerifier />
        <div className="pf-state" role="status">
          <span className="pf-state-icon">
            <FileSearch aria-hidden />
          </span>
          <h1 className="title-m">No manifest with this id</h1>
          <p className="body">
            Intyr has no manifest <code className="pf-code">{manifestId}</code> on MainNet or TestNet. Check the id for typos, or paste the manifest JSON
            or its anchor transaction id to verify it directly.
          </p>
          <ButtonLink to="/verify" variant="secondary">
            Verify something else
          </ButtonLink>
        </div>
      </div>
    );
  }

  if (manifest.error && !verification.data) {
    return (
      <div className="container section-tight pf-page">
        <BackToVerifier />
        <div className="pf-head">
          <p className="pf-eyebrow">Manifest {shortId(manifestId)}</p>
          <h1 className="title-m">This manifest could not be loaded</h1>
        </div>
        <div className="pf-panel" role="status">
          <ErrorState error={manifest.error} what="this manifest" onRetry={manifest.reload} />
        </div>
      </div>
    );
  }

  return (
    <div className="container section-tight pf-page">
      <BackToVerifier />
      <header className="pf-head">
        <span className="badge">
          <FileSearch aria-hidden />
          Public verifier
        </span>
        <h1 className="pf-claim">{claimSentence(view)}</h1>
        <div className="pf-meta">
          <span className="pf-meta-item">
            <span className="meta">Manifest</span>
            <HashText value={manifestId} label="manifest id" />
          </span>
          <KindChip view={view} />
          {view.status ? <ManifestStatusChip status={view.status} /> : null}
          {view.finalState ? (
            <span className="pf-meta-item">
              <span className="meta">Trip ended as</span>
              <TripStateChip state={view.finalState} />
            </span>
          ) : null}
        </div>
        {view.kind ? <p className="body pf-measure">{KIND_COPY[view.kind].explain}</p> : null}
        {manifest.error ? (
          <Notice kind="unknown" title="The stored record did not load.">
            The verifier result is shown below. Details that come only from the stored record read as not provided.
          </Notice>
        ) : null}
      </header>
      <ProofReport
        view={view}
        verification={verification}
        onRecheck={verification.reload}
        rawHref={rawHref}
        command={verifyCommand(JSON.stringify({ manifest_id: manifestId }), verification.data?.answered_by)}
      />
    </div>
  );
}

function BackToVerifier() {
  return (
    <Link to="/verify" className="pf-back">
      <ArrowLeft aria-hidden />
      Verify another receipt
    </Link>
  );
}

function KindChip({ view }: { view: ManifestView }) {
  if (view.kind) {
    return (
      <Chip tone="outline" icon={<FileText aria-hidden />} title={view.rawKind}>
        {KIND_COPY[view.kind].title}
      </Chip>
    );
  }
  if (view.rawKind) {
    return (
      <Chip tone="outline" icon={<FileText aria-hidden />}>
        {labelFromCode(view.rawKind)}
      </Chip>
    );
  }
  return null;
}

const MANIFEST_STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: "Current record", tone: "outline" },
  SUPERSEDED: { label: "Superseded", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  REVOKED: { label: "Revoked", tone: "danger" },
};

function ManifestStatusChip({ status }: { status: string }) {
  const known = MANIFEST_STATUS[status];
  return (
    <Chip tone={known?.tone ?? "neutral"} title={status}>
      {known?.label ?? labelFromCode(status)}
    </Chip>
  );
}

/* ------------------------------------------------------------------ */
/* The report, shared by /verify/:id and the inline result on /verify  */
/* ------------------------------------------------------------------ */

interface VerificationState {
  data: VerifyResult | undefined;
  error: Error | undefined;
  loading: boolean;
}

function ProofReport({
  view,
  verification,
  onRecheck,
  rawHref,
  command,
  commandNote,
}: {
  view: ManifestView;
  verification: VerificationState;
  onRecheck: () => void;
  rawHref?: string;
  command: string;
  commandNote?: string;
}) {
  const result = readVerify(verification.data);
  const pending = !result && !verification.error;
  const proofState = result?.proofState;
  const environment = view.environment ?? result?.environment;
  const grades = view.grades.length > 0 ? view.grades : (result?.grades ?? []);
  const sandboxSuppliers = grades.some(isBelowProduction) || view.legs.some((leg) => leg.supplierMode !== undefined && leg.supplierMode !== "LIVE");
  const anchors = result && result.anchors.length > 0 ? result.anchors : view.anchors;
  const superseded = proofState === "MANIFEST_SUPERSEDED" || view.status === "SUPERSEDED" || view.supersededBy !== undefined;
  const firstRound = anchors.find((a) => a.round !== undefined)?.round;
  const uid = useId();

  return (
    <div className="pf-report">
      <Verdict verification={verification} result={result} view={view} onRecheck={onRecheck} rawHref={rawHref} />

      {superseded ? (
        <Notice kind="info" icon={<Layers aria-hidden />} title="A newer manifest replaced this one.">
          {view.supersededBy ? (
            <>
              The current record is{" "}
              <Link className="link" to={`/verify/${encodeURIComponent(view.supersededBy)}`}>
                {shortId(view.supersededBy)}
              </Link>
              . This one stays on file as history.
            </>
          ) : (
            "The id of the newer manifest was not provided."
          )}
        </Notice>
      ) : null}

      <div className="pf-report-grid">
        <div className="pf-col">
          <section className="pf-panel" aria-labelledby={`${uid}-checks`}>
            <h2 id={`${uid}-checks`} className="pf-panel-title">
              Checks
            </h2>
            <CheckList result={result} pending={pending} failed={verification.error !== undefined} />
          </section>

          <section className="pf-panel" aria-label="What this record proves and what it does not">
            <ProofLead result={result} pending={pending} />
            <div className="pf-proves">
              <div className="pf-proves-card">
                <h2 className="pf-proves-title">
                  <CircleCheck aria-hidden />
                  What this proves
                </h2>
                <ul className={cx("pf-proves-list", proofState === "PROOF_VERIFIED" ? "is-yes" : "is-open")}>
                  <li>
                    <Check aria-hidden />
                    <span>The record is unchanged since Intyr signed it.</span>
                  </li>
                  {proofState === "PROOF_VERIFIED" ? (
                    <li>
                      <Check aria-hidden />
                      <span>
                        {firstRound !== undefined ? `It was anchored on Algorand at round ${firstRound}.` : "It was anchored on Algorand at the round shown under Anchors."}
                      </span>
                    </li>
                  ) : null}
                  <li>
                    <Check aria-hidden />
                    <span>
                      It was signed by a published Intyr key{view.keyId ? <>, <code className="pf-code">{view.keyId}</code></> : null}.
                    </span>
                  </li>
                </ul>
              </div>
              <div className="pf-proves-card">
                <h2 className="pf-proves-title">
                  <CircleDashed aria-hidden />
                  What it does not prove
                </h2>
                <ul className="pf-proves-list is-no">
                  <li>
                    <Minus aria-hidden />
                    <span>That the supplier's data was true. Intyr records what each supplier returned.</span>
                  </li>
                  <li>
                    <Minus aria-hidden />
                    <span>That a sandbox or simulated supplier is real. Those legs never reached a live supplier.</span>
                  </li>
                  <li>
                    <Minus aria-hidden />
                    <span>
                      That any refund or protection exists. Assurance is none in this release
                      {view.assurance ? (
                        <>
                          {" "}
                          (this record says <code className="pf-code">{view.assurance}</code>)
                        </>
                      ) : null}
                      .
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </section>
        </div>

        <div className="pf-col">
          <section className="pf-panel" aria-labelledby={`${uid}-scope`}>
            <h2 id={`${uid}-scope`} className="pf-panel-title">
              Environment and suppliers
            </h2>
            <dl className="kv pf-kv">
              <dt>Environment</dt>
              <dd>
                <EnvChip environment={environment} />
              </dd>
              <dt>Supplier mode</dt>
              <dd>
                <GradeChips grades={grades} />
              </dd>
              <dt>Issued</dt>
              <dd>{when(view.createdAt)}</dd>
              {view.kind !== "TRANSACTION" ? (
                <>
                  <dt>Valid until</dt>
                  <dd>{when(view.expiresAt)}</dd>
                </>
              ) : null}
              <dt>Trip</dt>
              <dd>{view.tripId ? <code className="pf-code">{view.tripId}</code> : <NotProvided />}</dd>
            </dl>
            {sandboxSuppliers ? <SupplierScopeBanner /> : null}
            <LegList legs={view.legs} />
          </section>

          <section className="pf-panel" aria-labelledby={`${uid}-anchors`}>
            <h2 id={`${uid}-anchors`} className="pf-panel-title">
              Anchors
            </h2>
            {pending && anchors.length === 0 ? <Skeleton height={72} /> : <AnchorList anchors={anchors} environment={environment} />}
          </section>

          {view.payments !== undefined ? (
            <section className="pf-panel" aria-labelledby={`${uid}-payments`}>
              <h2 id={`${uid}-payments`} className="pf-panel-title">
                Payments in this record
              </h2>
              <PaymentList payments={view.payments} environment={environment} emptyText="This record lists no payments." />
            </section>
          ) : null}

          <section className="pf-panel" aria-labelledby={`${uid}-sig`}>
            <h2 id={`${uid}-sig`} className="pf-panel-title">
              Signature and hash
            </h2>
            <dl className="kv pf-kv">
              <dt>Signing key</dt>
              <dd>{view.keyId ? <code className="pf-code">{view.keyId}</code> : <NotProvided />}</dd>
              <dt>Key list</dt>
              <dd>
                <KeyStatus keyId={view.keyId} />
              </dd>
              <dt>Algorithm</dt>
              <dd>{view.signatureAlg ?? <NotProvided />}</dd>
              <dt>Signed context</dt>
              <dd>{view.signatureContext ? <code className="pf-code">{view.signatureContext}</code> : <NotProvided />}</dd>
              <dt>Manifest hash</dt>
              <dd>{view.hash ? <HashText value={view.hash} label="manifest hash" /> : <NotProvided />}</dd>
              {result?.hash && result.hash !== view.hash ? (
                <>
                  <dt>Hash from the verifier</dt>
                  <dd>
                    <HashText value={result.hash} label="hash from the verifier" />
                  </dd>
                </>
              ) : null}
              {view.supersedes ? (
                <>
                  <dt>Replaces</dt>
                  <dd>
                    <Link className="link mono" to={`/verify/${encodeURIComponent(view.supersedes)}`}>
                      {shortId(view.supersedes)}
                    </Link>
                  </dd>
                </>
              ) : null}
            </dl>
            <a className="pf-ext" href={SIGNING_KEYS_PATH} target="_blank" rel="noreferrer">
              Published signing keys
              <ArrowUpRight aria-hidden />
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </section>

          <section className="pf-panel" aria-labelledby={`${uid}-rerun`}>
            <h2 id={`${uid}-rerun`} className="pf-panel-title">
              Check it yourself
            </h2>
            {rawHref ? (
              <a className="pf-ext" href={rawHref} target="_blank" rel="noreferrer">
                Raw manifest JSON
                <ArrowUpRight aria-hidden />
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : null}
            <p className="small muted">Re-run the same verification from a terminal:</p>
            <div className="pf-command">
              <CopyField value={command} label="verification command" />
            </div>
            {commandNote ? <p className="meta">{commandNote}</p> : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function LegList({ legs }: { legs: LegView[] }) {
  if (legs.length === 0) return null;
  return (
    <ul className="pf-list" aria-label="Legs in this record">
      {legs.map((leg, i) => (
        <li key={leg.id ?? `leg-${i}`} className="pf-item">
          <div className="pf-item-head">
            <span className="pf-item-title">
              {leg.type ? (COMPONENT_TYPE[leg.type] ?? labelFromCode(leg.type)) : `Leg ${i + 1}`}
              {leg.supplier ? <span className="pf-leg-supplier"> {leg.supplier}</span> : null}
            </span>
            {leg.supplierMode ? (
              <Chip tone={leg.supplierMode === "LIVE" ? "outline" : "amber"} enumStyle title="Supplier mode">
                {leg.supplierMode}
              </Chip>
            ) : null}
          </div>
          <div className="pf-chips">
            {leg.grade ? <GradeChips grades={[leg.grade]} /> : <span className="pf-missing">Evidence grade not provided</span>}
            {leg.legClass ? <code className="pf-code">{leg.legClass}</code> : null}
          </div>
          {leg.faults.length > 0 ? (
            <p className="pf-leg-faults">
              Seeded faults:{" "}
              {leg.faults.map((fault) => (
                <code key={fault} className="pf-code">
                  {fault}
                </code>
              ))}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function KeyStatus({ keyId }: { keyId: string | undefined }) {
  const keys = useResource("signing-keys", (signal) => api.getSigningKeys(signal));
  if (!keys.loaded) return <span className="pf-missing">Checking the published key list</span>;
  if (keys.error) {
    return <span className="pf-missing">{isNotFound(keys.error) ? "Key list not published yet" : "The published key list did not load"}</span>;
  }
  if (!keyId) return <NotProvided />;
  const list = pick(keys.data, "keys");
  if (!Array.isArray(list)) return <span className="pf-missing">The key list has no keys</span>;
  const entry = list.filter(isRecord).find((key) => readText(key.key_id) === keyId);
  if (!entry) {
    return (
      <Chip tone="danger" icon={<CircleX aria-hidden />}>
        Not in the published list
      </Chip>
    );
  }
  if (entry.revoked === true) {
    return (
      <Chip tone="danger" icon={<CircleX aria-hidden />}>
        Revoked in the published list
      </Chip>
    );
  }
  return (
    <Chip tone="outline" icon={<KeyRound aria-hidden />}>
      In the published list
    </Chip>
  );
}

const PROOF_GLYPH: Record<ProofState, ReactNode> = {
  PROOF_VERIFIED: <CircleCheck aria-hidden />,
  PROOF_PARTIAL: <CircleDashed aria-hidden />,
  SIGNATURE_INVALID: <CircleX aria-hidden />,
  HASH_MISMATCH: <CircleX aria-hidden />,
  ANCHOR_NOT_FOUND: <CircleX aria-hidden />,
  ANCHOR_UNCONFIRMED: <Clock3 aria-hidden />,
  MANIFEST_SUPERSEDED: <Layers aria-hidden />,
  INDEXER_UNAVAILABLE: <WifiOff aria-hidden />,
};

/** The safe next step for each proof state (internal E6 S12). */
const PROOF_NEXT: Record<ProofState, string> = {
  PROOF_VERIFIED: "Nothing to do. You can re-run the check yourself with the command below at any time.",
  PROOF_PARTIAL: "Check again in a minute. Until the anchor confirms, only the signature and hash are established.",
  SIGNATURE_INVALID: "Do not rely on this record. Compare its signing key with the keys Intyr publishes.",
  HASH_MISMATCH: "Do not rely on this copy. Fetch the stored record from the raw JSON link and check that one.",
  ANCHOR_NOT_FOUND: "Treat the chain claim as unproven. Open the anchor transaction in the explorer and look for yourself.",
  ANCHOR_UNCONFIRMED: "Check again shortly. This page does not count the anchor until the chain confirms it.",
  MANIFEST_SUPERSEDED: "Open the current record for the latest terms. This one stays on file as history.",
  INDEXER_UNAVAILABLE: "Try again later. Until then the chain part of this record is unchecked.",
};

const RECHECKABLE = new Set<ProofState>(["PROOF_PARTIAL", "ANCHOR_UNCONFIRMED", "INDEXER_UNAVAILABLE"]);

function Verdict({
  verification,
  result,
  view,
  onRecheck,
  rawHref,
}: {
  verification: VerificationState;
  result: VerifyView | undefined;
  view: ManifestView;
  onRecheck: () => void;
  rawHref?: string;
}) {
  const recheck = (
    <Button variant="secondary" size="sm" onClick={onRecheck} loading={verification.loading}>
      Check again
    </Button>
  );

  if (!result && !verification.error) {
    return (
      <VerdictStrip tone="unknown" glyph={<Ring label="Checking" />} label="Checking this record" busy>
        <p>Intyr is checking the signature, the hash and the Algorand anchor. Nothing is marked verified until it answers.</p>
      </VerdictStrip>
    );
  }

  if (!result && verification.error) {
    const error = verification.error;
    const apiError = error instanceof ApiError ? error : undefined;
    const codes: unknown = apiError?.body.reason_codes;
    const reason = Array.isArray(codes) ? readText(codes[0]) : undefined;
    const serverMessage = readText(apiError?.body.message);
    let label = "Verification did not run";
    let glyph: ReactNode = <CircleQuestionMark aria-hidden />;
    let text = error.message;
    if (apiError?.unreachable) {
      label = "The verifier could not be reached";
      glyph = <WifiOff aria-hidden />;
      text = "There is no result yet, so nothing on this page is verified. Check your connection and try again.";
    } else if (isNotFound(error)) {
      label = "No verification result";
      text = "The verifier answered that it has nothing for this input, so nothing on this page is verified.";
    } else if (isNotAvailable(error)) {
      label = "Verification is not available right now";
      text = serverMessage ?? "The verifier is not available in this deployment yet. Nothing on this page is verified.";
    } else if (apiError && (apiError.status === 400 || apiError.status === 422)) {
      label = "The verifier rejected this input";
      text = reason ? describeReason(reason) : error.message;
    }
    return (
      <VerdictStrip tone="unknown" glyph={glyph} label={label} code={apiError?.code} actions={recheck}>
        <p>{text}</p>
      </VerdictStrip>
    );
  }

  const state = result?.proofState;
  const checkedAt = result?.verifiedAt ? `Checked ${when(result.verifiedAt)}` : undefined;
  const meta = [checkedAt, result?.indexer ? `Indexer ${result.indexer}` : undefined].filter(Boolean).join(" · ");

  if (!state || !isProofState(state)) {
    return (
      <VerdictStrip tone="unknown" glyph={<CircleQuestionMark aria-hidden />} label={state ? labelFromCode(state) : "No proof state returned"} code={state} actions={recheck}>
        <p>The verifier answered with a result this page does not recognize. Treat the record as unverified.</p>
        {meta ? <p className="pf-verdict-meta">{meta}</p> : null}
      </VerdictStrip>
    );
  }

  const proof = PROOF_STATE[state];
  let actions: ReactNode = null;
  if (RECHECKABLE.has(state)) actions = recheck;
  else if (state === "SIGNATURE_INVALID") {
    actions = (
      <a className="btn btn-secondary btn-sm" href={SIGNING_KEYS_PATH} target="_blank" rel="noreferrer">
        Published signing keys
      </a>
    );
  } else if (state === "HASH_MISMATCH" && rawHref) {
    actions = (
      <a className="btn btn-secondary btn-sm" href={rawHref} target="_blank" rel="noreferrer">
        Stored record
      </a>
    );
  } else if (state === "MANIFEST_SUPERSEDED" && view.supersededBy) {
    actions = (
      <ButtonLink to={`/verify/${encodeURIComponent(view.supersededBy)}`} variant="secondary" size="sm">
        Open the current record
      </ButtonLink>
    );
  }

  return (
    <VerdictStrip tone={proof.tone} glyph={PROOF_GLYPH[state]} label={proof.label} code={state} actions={actions} busy={verification.loading}>
      <p>{proof.explain}</p>
      <p className="pf-verdict-next">{PROOF_NEXT[state]}</p>
      {meta ? <p className="pf-verdict-meta">{meta}</p> : null}
    </VerdictStrip>
  );
}

function VerdictStrip({
  tone,
  glyph,
  label,
  code,
  actions,
  busy,
  children,
}: {
  tone: Tone;
  glyph: ReactNode;
  label: string;
  code?: string;
  actions?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx("pf-verdict", `pf-tone-${tone}`)} role="status" aria-busy={busy || undefined}>
      <span className="pf-verdict-glyph">{glyph}</span>
      <div className="pf-verdict-body">
        <p className="pf-verdict-label">{label}</p>
        <div className="pf-verdict-text">{children}</div>
      </div>
      {code || actions ? (
        <div className="pf-verdict-side">
          {code ? (
            <Chip tone={tone} enumStyle>
              {code}
            </Chip>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function ProofLead({ result, pending }: { result: VerifyView | undefined; pending: boolean }) {
  const state = result?.proofState;
  let text: string;
  if (pending) text = "None of this holds until the verifier returns a result.";
  else if (!result) text = "The verifier returned no result, so none of this is established for this record.";
  else if (state === "PROOF_VERIFIED") text = "Every check passed, so each point under What this proves holds for this record.";
  else {
    const label = state && isProofState(state) ? PROOF_STATE[state].label : "not a full verification";
    text = `The result is ${label.toLowerCase()}. Only the points backed by a PASS check above hold for this record.`;
  }
  return <p className="pf-lead">{text}</p>;
}

const CHECK_STATUS: Record<string, { tone: Tone; icon: ReactNode }> = {
  PASS: { tone: "success", icon: <Check aria-hidden /> },
  FAIL: { tone: "danger", icon: <X aria-hidden /> },
  PENDING: { tone: "unknown", icon: <Clock3 aria-hidden /> },
  SKIPPED: { tone: "neutral", icon: <Minus aria-hidden /> },
};

function CheckList({ result, pending, failed }: { result: VerifyView | undefined; pending: boolean; failed: boolean }) {
  if (pending) {
    return (
      <div className="pf-skel-list" aria-hidden>
        <Skeleton height={20} />
        <Skeleton height={20} width="85%" />
        <Skeleton height={20} width="70%" />
      </div>
    );
  }
  if (!result) {
    return <p className="pf-empty">{failed ? "No checks ran because the verifier did not return a result." : "No checks were returned."}</p>;
  }
  if (!result.checks) return <p className="pf-empty">The verifier did not return a list of checks.</p>;
  if (result.checks.length === 0) return <p className="pf-empty">The verifier returned an empty list of checks.</p>;
  return (
    <ol className="pf-checks">
      {result.checks.map((check, i) => {
        const status = check.status ? CHECK_STATUS[check.status] : undefined;
        return (
          <li key={`${check.name ?? "check"}-${i}`} className="pf-check">
            <span className="pf-check-status">
              {check.status ? (
                <Chip tone={status?.tone ?? "neutral"} enumStyle icon={status?.icon}>
                  {check.status}
                </Chip>
              ) : (
                <NotProvided />
              )}
            </span>
            <div className="pf-check-body">
              <p className="pf-check-name">{check.name ? labelFromCode(check.name) : "Unnamed check"}</p>
              {check.detail ? <p className="pf-check-detail">{check.detail}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* /verify                                                             */
/* ------------------------------------------------------------------ */

type VerifyInput =
  | { kind: "manifest_id"; id: string }
  | { kind: "txid"; txid: string }
  | { kind: "manifest_json"; manifest: Record<string, unknown> };

type ParseResult = { ok: true; input: VerifyInput } | { ok: false; message: string };

/** Algorand transaction ids are 52 characters of base32 without padding. */
const TXID = /^[A-Z2-7]{52}$/;
const MANIFEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;
const VERIFY_URL = /\/verify\/([^/?#\s]+)/;

function parseInput(raw: string): ParseResult | null {
  const value = raw.trim();
  if (value === "") return null;
  if (value.startsWith("{") || value.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      return { ok: false, message: `This is not valid JSON. ${error instanceof Error ? error.message : ""}`.trim() };
    }
    if (!isRecord(parsed)) return { ok: false, message: "Paste one manifest object, not a list or a single value." };
    return { ok: true, input: { kind: "manifest_json", manifest: parsed } };
  }
  const fromUrl = VERIFY_URL.exec(value)?.[1];
  if (fromUrl) {
    const id = decodeURIComponent(fromUrl);
    if (MANIFEST_ID.test(id)) return { ok: true, input: { kind: "manifest_id", id } };
  }
  if (TXID.test(value)) return { ok: true, input: { kind: "txid", txid: value } };
  if (MANIFEST_ID.test(value)) return { ok: true, input: { kind: "manifest_id", id: value } };
  return {
    ok: false,
    message:
      "This does not read as a manifest id or an Algorand transaction id. Manifest ids use letters, digits, hyphens and underscores. Transaction ids are 52 characters from A to Z and 2 to 7.",
  };
}

const DETECTED: Record<VerifyInput["kind"], string> = {
  manifest_id: "Reads as a manifest id. Verify opens its public record.",
  txid: "Reads as an Algorand transaction id. The verifier looks up the manifest anchored in it.",
  manifest_json: "Reads as manifest JSON. It is sent to the verifier exactly as pasted.",
};

type Submission =
  | { status: "idle" }
  | { status: "running"; input: VerifyInput }
  | { status: "done"; input: VerifyInput; result: VerifyResult }
  | { status: "failed"; input: VerifyInput; error: Error };

function VerifyFormPage() {
  const navigate = useNavigate();
  const fieldId = useId();
  const resultId = useId();
  const [value, setValue] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [submission, setSubmission] = useState<Submission>({ status: "idle" });
  const requestRef = useRef(0);

  const parsed = parseInput(value);
  const invalid = attempted && (parsed === null || !parsed.ok);
  const message =
    parsed === null
      ? attempted
        ? "Enter a manifest id, a transaction id or manifest JSON."
        : "Paste one of the three. The check is free and needs no account, wallet or payment."
      : parsed.ok
        ? DETECTED[parsed.input.kind]
        : attempted
          ? parsed.message
          : "Keep typing, or press Verify to check the input.";

  const run = (input: VerifyInput) => {
    const request = ++requestRef.current;
    setSubmission({ status: "running", input });
    const body = input.kind === "txid" ? { txid: input.txid } : input.kind === "manifest_json" ? { manifest: input.manifest } : { manifest_id: input.id };
    void api.verifyAnywhere(body).then(
      (result) => {
        if (request === requestRef.current) setSubmission({ status: "done", input, result });
      },
      (cause: unknown) => {
        if (request === requestRef.current) {
          setSubmission({ status: "failed", input, error: cause instanceof Error ? cause : new Error(String(cause)) });
        }
      },
    );
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (!parsed || !parsed.ok) return;
    if (parsed.input.kind === "manifest_id") {
      void navigate(`/verify/${encodeURIComponent(parsed.input.id)}`);
      return;
    }
    run(parsed.input);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const jsonMode = value.trimStart().startsWith("{");
    if (jsonMode && !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <div className="container section-tight pf-page">
      <div className="pf-verify">
        <div className="pf-verify-main">
          <header className="pf-head">
            <span className="badge">
              <FileSearch aria-hidden />
              Public verifier
            </span>
            <h1 className="h2">Check an Intyr receipt</h1>
            <p className="body-l pf-measure">
              Every Intyr outcome is a signed manifest whose hash is anchored on Algorand. Paste its id, its anchor transaction id, or the manifest JSON,
              and the verifier checks it against the published keys and the chain.
            </p>
          </header>

          <form className="pf-form" onSubmit={onSubmit} noValidate>
            <label htmlFor={fieldId} className="field-label">
              Manifest id, Algorand transaction id or manifest JSON
            </label>
            <textarea
              id={fieldId}
              className="textarea pf-input"
              rows={3}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              aria-invalid={invalid || undefined}
              aria-describedby={`${fieldId}-hint`}
            />
            <p id={`${fieldId}-hint`} className={invalid ? "field-error" : "field-hint"}>
              {message}
            </p>
            <div className="pf-form-actions">
              <Button type="submit" size="lg" loading={submission.status === "running"}>
                Verify
              </Button>
              <span className="meta">Enter submits an id. For JSON, press Ctrl or Cmd with Enter.</span>
            </div>
          </form>

          <p className="small muted">
            Looking for the canonical run?{" "}
            <Link className="link" to="/evidence/RUN-001">
              See the evidence for RUN-001
            </Link>
            .
          </p>
        </div>

        <aside className="pf-how" aria-labelledby={`${fieldId}-how`}>
          <h2 id={`${fieldId}-how`} className="pf-panel-title">
            What the verifier checks
          </h2>
          <ol className="pf-steps">
            <li>
              <span className="pf-num">01</span>
              <div>
                <p className="pf-step-title">Hash</p>
                <p className="pf-step-text">
                  Recomputes SHA-256 over the RFC 8785 canonical form of the manifest and compares it with the recorded <code className="pf-code">sha256:</code>{" "}
                  hash.
                </p>
              </div>
            </li>
            <li>
              <span className="pf-num">02</span>
              <div>
                <p className="pf-step-title">Signature</p>
                <p className="pf-step-text">
                  Checks the Ed25519 signature against the keys Intyr publishes at{" "}
                  <a className="link" href={SIGNING_KEYS_PATH} target="_blank" rel="noreferrer">
                    {SIGNING_KEYS_PATH}
                  </a>
                  .
                </p>
              </div>
            </li>
            <li>
              <span className="pf-num">03</span>
              <div>
                <p className="pf-step-title">Anchor</p>
                <p className="pf-step-text">Finds the Algorand transaction that carries the hash and reads the round it was confirmed in.</p>
              </div>
            </li>
          </ol>
          <p className="pf-step-text">
            It cannot tell you whether a supplier's answer was true. Each record says which of its suppliers were sandbox or simulated.
          </p>
        </aside>
      </div>

      {submission.status !== "idle" ? (
        <section className="pf-result" aria-labelledby={resultId}>
          <div className="pf-head">
            <h2 id={resultId} className="title-m">
              Result
            </h2>
            <p className="body pf-measure">{subjectSentence(submission.input)}</p>
            {submission.status === "done" && readText(pick(submission.result, "manifest_id")) ? (
              <div className="row">
                <ButtonLink to={`/verify/${encodeURIComponent(readText(pick(submission.result, "manifest_id")) ?? "")}`} variant="secondary" size="sm">
                  Open the full record
                </ButtonLink>
              </div>
            ) : null}
          </div>
          <ProofReport
            view={submission.input.kind === "manifest_json" ? readManifest(submission.input.manifest) : readManifest(undefined)}
            verification={{
              data: submission.status === "done" ? submission.result : undefined,
              error: submission.status === "failed" ? submission.error : undefined,
              loading: submission.status === "running",
            }}
            onRecheck={() => run(submission.input)}
            command={commandFor(submission.input)}
            commandNote={
              submission.input.kind === "manifest_json" ? "Save the pasted manifest as manifest.json in the current folder first. The command wraps it as the manifest field." : undefined
            }
          />
        </section>
      ) : null}
    </div>
  );
}

function subjectSentence(input: VerifyInput): string {
  if (input.kind === "txid") return `The manifest anchored in transaction ${shortId(input.txid, 8, 6)}.`;
  if (input.kind === "manifest_id") return `Manifest ${input.id}.`;
  return `The pasted manifest. ${claimSentence(readManifest(input.manifest))}`;
}

function commandFor(input: VerifyInput): string {
  if (input.kind === "txid") return verifyCommand(JSON.stringify({ txid: input.txid }));
  if (input.kind === "manifest_id") return verifyCommand(JSON.stringify({ manifest_id: input.id }));
  return `printf '{"manifest":%s}' "$(cat manifest.json)" | curl -s -X POST ${window.location.origin}${PUBLIC}/manifests/verify -H 'content-type: application/json' --data-binary @-`;
}
