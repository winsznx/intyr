import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useParams } from "react-router";
import { ExternalLink, FileCheck2, RefreshCw } from "lucide-react";
import { ActionResult, type ActionOutcome } from "../../components/action-result";
import { AppBar } from "../../components/shell";
import { RailsLegend, TripRails } from "../../components/trip-rails";
import {
  Button,
  ButtonLink,
  Chip,
  DecisionChip,
  ErrorState,
  HashText,
  Notice,
  ReasonList,
  Ring,
  Skeleton,
  TripStateChip,
} from "../../components/ui";
import { api } from "../../lib/api";
import { algoExplorerTx, formatDateTime, formatMoney } from "../../lib/format";
import { COMPONENT_TYPE, UNKNOWN_COPY, describeReason, tripState } from "../../lib/labels";
import { componentNames as names, recoverySentence, sentenceStart } from "../../lib/recovery";
import type { NextAction, Trip } from "../../lib/types";
import { useResource } from "../../lib/use-resource";

const RUNNING_COMPONENT = new Set(["PREPARING", "COMMIT_SUBMITTED", "COMMIT_RESPONDED", "COMMIT_STATUS_UNKNOWN", "CANCELLING"]);

function isRunning(trip: Trip | undefined): boolean {
  if (!trip) return true;
  return Boolean(tripState(trip.state).running) || trip.components.some((c) => RUNNING_COMPONENT.has(c.state));
}

type ActionName = "REVALIDATE" | "COMMIT" | "RECOVER";

export function TripPage() {
  const { tripId = "" } = useParams();
  const trip = useResource(`trip:${tripId}`, (signal) => api.getTrip(tripId, signal), { pollMs: 2000, shouldPoll: isRunning });
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);

  const run = async (action: ActionName) => {
    if (!trip.data) return;
    setBusy(action);
    setOutcome(null);
    try {
      const response =
        action === "REVALIDATE"
          ? await api.revalidateTrip(trip.data.trip_id)
          : action === "COMMIT"
            ? await api.commitTrip({
                trip_id: trip.data.trip_id,
                manifest_id: trip.data.initial_manifest_id ?? "",
                manifest_hash: trip.data.manifest_hash ?? "",
                maximum_total_minor: trip.data.maximum_total?.amount_minor ?? trip.data.total?.amount_minor ?? 0,
                currency: trip.data.total?.currency ?? trip.data.maximum_total?.currency ?? "USD",
              })
            : await api.recoverTrip(trip.data.trip_id);
      setOutcome({ ok: true, action, response });
    } catch (error) {
      setOutcome({ ok: false, action, error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      setBusy(null);
      trip.reload();
    }
  };

  const crumbs = [{ label: "Trips", to: "/app" }, { label: trip.data?.label ?? tripId }];

  if (!trip.loaded) {
    return (
      <>
        <AppBar crumbs={crumbs} />
        <div className="app-content stack-lg" aria-busy="true">
          <Skeleton width={260} height={28} />
          <Skeleton height={96} />
          <Skeleton height={220} />
        </div>
      </>
    );
  }

  if (!trip.data) {
    return (
      <>
        <AppBar crumbs={crumbs} />
        <div className="app-content">
          <div className="card">
            <ErrorState error={trip.error ?? new Error("Unknown error")} onRetry={trip.reload} what="this trip" />
          </div>
        </div>
      </>
    );
  }

  const t = trip.data;
  const actions = t.next_actions ?? [];
  const find = (name: string) => actions.find((a) => a.action === name);

  return (
    <>
      <AppBar
        crumbs={crumbs}
        end={
          <>
            {trip.loading ? <Ring label="Refreshing" /> : null}
            <button type="button" className="icon-btn" onClick={trip.reload} aria-label="Refresh trip">
              <RefreshCw aria-hidden />
            </button>
          </>
        }
      />
      <div className="app-content stack-lg">
        {trip.error ? (
          <Notice kind="danger" title="Showing the last state the server returned.">
            The latest refresh failed: {trip.error.message}
          </Notice>
        ) : null}

        <VerdictStrip trip={t} actions={actions} busy={busy} onRevalidate={() => void run("REVALIDATE")} onCommit={() => confirmRef.current?.showModal()} onRecover={() => void run("RECOVER")} />

        <ActionResult outcome={outcome} />

        <section className="card" aria-labelledby="legs-title">
          <div className="card-head">
            <h2 className="card-title" id="legs-title">
              Legs in commit order
            </h2>
            <span className="meta">Legs that can be undone go first. The leg that cannot is committed last.</span>
          </div>
          <div className="card-pad">
            {t.components.length ? (
              <TripRails components={t.components} showClocks={!tripState(t.state).terminal} />
            ) : (
              <p className="muted">This trip has no legs yet.</p>
            )}
          </div>
          <div className="card-band">
            <RailsLegend />
          </div>
        </section>

        <div className="split">
          <div className="stack">
            <DecisionLog trip={t} />
            <SupplierNotes trip={t} />
          </div>
          <div className="stack">
            <MoneyCard trip={t} />
            <ProofCard trip={t} />
          </div>
        </div>
      </div>

      <CommitDialog dialogRef={confirmRef} trip={t} onConfirm={() => void run("COMMIT")} commitAction={find("COMMIT")} />
    </>
  );
}

const STRONG: Partial<Record<string, string>> = {
  COMMIT_STATUS_UNKNOWN: "dark",
  MANUAL_REVIEW: "review",
  RECOVERING: "attention",
  RECOVERY_FAILED: "failed",
};

function earliestClock(trip: Trip): string | undefined {
  const times = trip.components
    .flatMap((c) => [c.price_valid_until, c.inventory_held_until])
    .filter((t): t is string => Boolean(t))
    .sort();
  return times[0] ?? trip.deadline;
}

function VerdictStrip({
  trip,
  actions,
  busy,
  onRevalidate,
  onCommit,
  onRecover,
}: {
  trip: Trip;
  actions: NextAction[];
  busy: ActionName | null;
  onRevalidate: () => void;
  onCommit: () => void;
  onRecover: () => void;
}) {
  const state = tripState(trip.state);
  const find = (name: string) => actions.find((a) => a.action === name);
  const commit = find("COMMIT");
  const revalidate = find("REVALIDATE");
  const recover = find("RECOVER");
  const committed = trip.components.filter((c) => c.state === "CONFIRMED").length;
  const refused = [...(trip.decisions ?? [])].reverse().find((d) => d.outcome === "REFUSE" && (d.gate === "COMMIT" || d.gate === "PREPARE"));
  const review = [...(trip.decisions ?? [])].reverse().find((d) => d.outcome === "MANUAL_REVIEW");
  const unknownDecision = [...(trip.decisions ?? [])].reverse().find((d) => d.outcome === "UNKNOWN");
  const allSandbox = trip.components.length > 0 && trip.components.every((c) => c.evidence_grade !== "SUPPLIER_PRODUCTION" && c.evidence_grade !== "SUPPLIER_SIGNED");
  const clock = earliestClock(trip);
  const validUntil = clock ? `valid until ${formatDateTime(clock)}` : "valid for a limited time";
  const failedLeg = trip.components.find((c) => c.state === "COMMIT_FAILED" || c.state === "UNAVAILABLE");
  const stillBooked = trip.components.filter((c) => c.state === "CONFIRMED");
  const strong = STRONG[trip.state];

  let headline: ReactNode = state.label;
  let explain: ReactNode = null;
  switch (trip.state) {
    case "DRAFT":
      explain = "Not sent to any supplier yet.";
      break;
    case "CHECKED":
      explain = "Check only. No supplier was contacted and this plan cannot be committed.";
      break;
    case "PREPARING":
      explain = `Checking ${trip.components.length || "the"} components with suppliers.`;
      break;
    case "REVALIDATING":
      explain = "Checking prices and availability again.";
      break;
    case "PREPARED":
    case "PREPARED_WITH_WARNINGS":
    case "READY_TO_COMMIT":
      if (refused && !commit?.allowed) {
        headline = "Intyr will not commit this trip";
        explain = `Intyr did not commit because ${describeReason(refused.reason_codes?.[0] ?? commit?.reason ?? "POLICY_DENIED").replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}. Nothing was booked. Prepare a different trip or change its limits.`;
      } else if (trip.state === "PREPARED_WITH_WARNINGS") {
        explain = commit?.reason ? describeReason(commit.reason) : "Review the warnings below before committing.";
      } else if (trip.state === "READY_TO_COMMIT") {
        explain = `Plan ${validUntil}. The commit fee is sponsored in the sandbox.`;
      } else {
        explain = `Plan ready, ${validUntil}.`;
      }
      break;
    case "COMMITTING":
      headline = `Committing ${committed} of ${trip.components.length} components`;
      explain = "You can leave this page. The commit continues on the server.";
      break;
    case "COMMIT_STATUS_UNKNOWN":
      explain = (
        <>
          {UNKNOWN_COPY}
          {unknownDecision?.reconcile_by ? ` If Intyr cannot confirm by ${formatDateTime(unknownDecision.reconcile_by)}, this trip moves to manual review.` : null}
        </>
      );
      break;
    case "COMMITTED_UNVERIFIED":
      explain = "Every component is confirmed. Intyr re-reads each supplier before marking the trip committed.";
      break;
    case "COMMITTED":
      explain = `Every component was confirmed by a supplier read after booking.${allSandbox ? " References are sandbox or simulated. Nothing real was booked." : ""}`;
      break;
    case "COMMIT_NOT_EXECUTED":
      explain = `The commit did not run: ${describeReason(refused?.reason_codes?.[0] ?? "TRIP_STATE_CONFLICT").replace(/\.$/, "").toLowerCase()}.${stillBooked.length === 0 ? " No component was booked." : ""}`;
      break;
    case "RECOVERING":
      explain = `${failedLeg ? sentenceStart(COMPONENT_TYPE[failedLeg.type] ?? failedLeg.type) : "A component"} failed at the supplier. Intyr is running the recovery accepted before commit.`;
      break;
    case "RECOVERED":
      explain = recoverySentence(trip);
      break;
    case "RECOVERY_FAILED":
      explain = `Recovery stopped before the trip reached a consistent state. Still booked: ${stillBooked.length ? names(stillBooked).toLowerCase() : "nothing"}.`;
      break;
    case "MANUAL_REVIEW":
      explain = review?.reason_codes?.length ? describeReason(review.reason_codes[0] ?? "") : "A person has to decide before anything moves.";
      break;
    case "PREPARATION_FAILED":
      explain = "No booking was made. The decision log names the component that could not be prepared.";
      break;
    case "CANCELLED":
      explain = "This trip was cancelled. The legs below show what was cancelled.";
      break;
    case "SERVICING":
      explain = "Not handled in this release.";
      break;
  }

  const blocked = trip.state === "COMMIT_STATUS_UNKNOWN";

  return (
    <section className="verdict" data-role="verdict-strip" data-strength={strong} aria-live="polite">
      <div className="verdict-main">
        <div className="row">
          <TripStateChip state={trip.state} />
          {trip.environment !== "MAINNET" ? <Chip tone="outline">TestNet sandbox</Chip> : null}
          {trip.scenario_seed !== undefined ? (
            <a className="meta link" href={`/sandbox/v1/evidence/sim/${trip.scenario_seed}/orders`} target="_blank" rel="noreferrer">
              Seeded scenario, seed {trip.scenario_seed}. Simulator order list
            </a>
          ) : null}
        </div>
        <h1 className="verdict-title">{headline}</h1>
        {explain ? <p className="verdict-explain">{explain}</p> : null}
      </div>
      <div className="verdict-actions">
        {!blocked && (trip.approval?.required || trip.state === "MANUAL_REVIEW") && !state.terminal ? (
          <ButtonLink to={`/app/trips/${trip.trip_id}/approve`} variant={strong ? "dark" : "primary"}>
            Review
          </ButtonLink>
        ) : null}
        {!blocked && commit && !trip.approval?.required && !(refused && !commit.allowed) ? (
          <Button onClick={onCommit} disabled={!commit.allowed} loading={busy === "COMMIT"} title={commit.reason ? describeReason(commit.reason) : undefined}>
            Commit trip
          </Button>
        ) : null}
        {!blocked && recover ? (
          <Button variant="dark" onClick={onRecover} disabled={!recover.allowed} loading={busy === "RECOVER"}>
            Start recovery
          </Button>
        ) : null}
        {!blocked && revalidate ? (
          <Button variant="secondary" onClick={onRevalidate} disabled={!revalidate.allowed} loading={busy === "REVALIDATE"}>
            Revalidate
          </Button>
        ) : null}
        {trip.manifest_id && ["COMMITTED", "RECOVERED", "RECOVERY_FAILED", "COMMIT_NOT_EXECUTED", "CHECKED"].includes(trip.state) ? (
          <ButtonLink to={`/verify/${trip.manifest_id}`} variant="secondary">
            <FileCheck2 aria-hidden size={16} /> Open proof
          </ButtonLink>
        ) : null}
      </div>
    </section>
  );
}

function DecisionLog({ trip }: { trip: Trip }) {
  const decisions = [...(trip.decisions ?? [])].reverse();
  const componentLabel = (id: string | undefined) => {
    const c = trip.components.find((x) => x.component_id === id);
    return c ? (c.label ?? COMPONENT_TYPE[c.type] ?? c.type) : undefined;
  };
  return (
    <section className="card" aria-labelledby="decisions-title">
      <div className="card-head">
        <h2 className="card-title" id="decisions-title">
          Decision log
        </h2>
        <span className="meta">Every gate records what it decided and why, including when it did nothing.</span>
      </div>
      {decisions.length === 0 ? (
        <p className="card-pad muted">No decisions recorded yet.</p>
      ) : (
        <ol className="decision-list">
          {decisions.map((d) => (
            <li key={d.decision_id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row">
                  <DecisionChip outcome={d.outcome} />
                  <span className="decision-gate">{gateLabel(d.gate)}</span>
                  {d.subject?.component_id ? <span className="meta">{componentLabel(d.subject.component_id)}</span> : null}
                </div>
                <span className="meta">{formatDateTime(d.decided_at)}</span>
              </div>
              <ReasonList codes={d.reason_codes} />
              {d.outcome === "UNKNOWN" && d.reconcile_by ? <p className="meta">Intyr keeps checking until {formatDateTime(d.reconcile_by)}, then asks a person.</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function gateLabel(gate: string): string {
  const map: Record<string, string> = {
    PAYMENT_ACCEPT: "Payment",
    PREPARE: "Prepare",
    COMMIT: "Commit",
    COMPONENT_CONFIRM: "Supplier confirmation",
    RECOVERY_ACTION: "Recovery step",
    REFUND: "Refund",
  };
  return map[gate] ?? gate;
}

function SupplierNotes({ trip }: { trip: Trip }) {
  const notes = trip.components.flatMap((c) => (c.untrusted_notes ?? []).map((note, i) => ({ key: `${c.component_id}-${i}`, who: c.supplier ?? c.type, note })));
  if (notes.length === 0) return null;
  return (
    <section className="card" aria-labelledby="notes-title">
      <div className="card-head">
        <h2 className="card-title" id="notes-title">
          Supplier notes
        </h2>
        <span className="meta">Written by suppliers. Shown as plain text and never used to make a decision.</span>
      </div>
      <ul className="notes-list">
        {notes.map((n) => (
          <li key={n.key}>
            <span className="meta">{n.who}</span>
            <p>{n.note}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MoneyCard({ trip }: { trip: Trip }) {
  return (
    <section className="card" aria-labelledby="money-title">
      <div className="card-head">
        <h2 className="card-title" id="money-title">
          Money
        </h2>
      </div>
      <dl className="kv card-pad">
        <dt>Quoted total</dt>
        <dd className="num">{formatMoney(trip.quoted_total ?? trip.total)}</dd>
        <dt>Still booked</dt>
        <dd className="num">{trip.booked_total ? formatMoney(trip.booked_total) : "Nothing booked"}</dd>
        <dt>Maximum allowed</dt>
        <dd className="num">{trip.maximum_total ? formatMoney(trip.maximum_total) : "Not set"}</dd>
        <dt>Stranded spend</dt>
        <dd className="num">{trip.stranded_spend ? formatMoney(trip.stranded_spend) : "None recorded"}</dd>
        <dt>Recovery policy</dt>
        <dd>Cancel what can be cancelled and stay inside the maximum set before commit. Protection: none in this release (assurance NONE).</dd>
        <dt>Supplier money</dt>
        <dd>Test mode or simulated. No real charge.</dd>
      </dl>
    </section>
  );
}

function ProofCard({ trip }: { trip: Trip }) {
  const anchor = trip.anchors?.[0];
  return (
    <section className="card" aria-labelledby="proof-title">
      <div className="card-head">
        <h2 className="card-title" id="proof-title">
          Receipt
        </h2>
        {trip.manifest_id ? (
          <Link className="link small" to={`/verify/${trip.manifest_id}`}>
            Verify
          </Link>
        ) : null}
      </div>
      <dl className="kv card-pad">
        <dt>Manifest</dt>
        <dd>{trip.manifest_id ? <HashText value={trip.manifest_id} label="manifest id" /> : "Not signed yet"}</dd>
        <dt>Manifest hash</dt>
        <dd>{trip.manifest_hash ? <HashText value={trip.manifest_hash} label="manifest hash" /> : "Not signed yet"}</dd>
        <dt>Algorand anchor</dt>
        <dd>
          {anchor?.txid ? (
            <span className="row" style={{ gap: 6 }}>
              <HashText value={anchor.txid} label="transaction id" />
              <a className="icon-btn" href={algoExplorerTx(anchor.txid, "TESTNET")} target="_blank" rel="noreferrer" aria-label="Open the transaction in an explorer">
                <ExternalLink aria-hidden />
              </a>
              <Chip tone={anchor.confirmed ? "success" : "running"} running={!anchor.confirmed}>
                {anchor.confirmed ? "Confirmed" : "Pending"}
              </Chip>
            </span>
          ) : trip.anchor_state ? (
            <Chip tone="running" running>
              {trip.anchor_state.toLowerCase().replace(/_/g, " ")}
            </Chip>
          ) : (
            "Not anchored yet"
          )}
        </dd>
        <dt>Created</dt>
        <dd>{formatDateTime(trip.created_at)}</dd>
      </dl>
    </section>
  );
}

function CommitDialog({
  dialogRef,
  trip,
  onConfirm,
  commitAction,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  trip: Trip;
  onConfirm: () => void;
  commitAction: NextAction | undefined;
}) {
  const irreversible = trip.components.filter((c) => c.irreversible);
  const close = () => dialogRef.current?.close();
  return (
    <dialog ref={dialogRef} className="sheet" aria-labelledby="commit-title">
      <div className="sheet-body">
        <h2 className="page-title" id="commit-title">
          Commit this trip?
        </h2>
        <p className="muted">
          Intyr books each leg at the supplier in the order shown and reads every booking back before calling it confirmed. If a leg fails, recovery runs
          inside the limits below. In the sandbox the service fee is sponsored and no USDC moves.
        </p>
        <dl className="kv">
          <dt>Total</dt>
          <dd className="num">{formatMoney(trip.total)}</dd>
          <dt>Maximum allowed</dt>
          <dd className="num">{trip.maximum_total ? formatMoney(trip.maximum_total) : "Not set"}</dd>
          <dt>Order</dt>
          <dd>
            {[...trip.components]
              .sort((a, b) => (a.commit_order ?? 99) - (b.commit_order ?? 99))
              .map((c) => c.label ?? COMPONENT_TYPE[c.type] ?? c.type)
              .join(", then ")}
          </dd>
          <dt>Cannot be undone</dt>
          <dd>{irreversible.length ? irreversible.map((c) => c.label ?? COMPONENT_TYPE[c.type] ?? c.type).join(", ") : "Every leg can be cancelled under its supplier terms"}</dd>
          <dt>Manifest</dt>
          <dd>{trip.manifest_hash ? <HashText value={trip.manifest_hash} label="manifest hash" /> : "Missing"}</dd>
        </dl>
        {!trip.manifest_hash || !trip.initial_manifest_id ? <Notice kind="refuse">This trip has no signed manifest, so it cannot be committed.</Notice> : null}
      </div>
      <div className="sheet-foot">
        <Button variant="secondary" onClick={close}>
          Keep reviewing
        </Button>
        <Button
          onClick={() => {
            close();
            onConfirm();
          }}
          disabled={!trip.manifest_hash || !trip.initial_manifest_id || commitAction?.allowed === false}
        >
          Commit trip
        </Button>
      </div>
    </dialog>
  );
}
