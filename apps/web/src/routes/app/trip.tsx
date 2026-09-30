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
  UnknownNotice,
} from "../../components/ui";
import { api } from "../../lib/api";
import { algoExplorerTx, formatDateTime, formatMoney, relativeTime } from "../../lib/format";
import { COMPONENT_TYPE, describeReason, tripState } from "../../lib/labels";
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
  const approval = find("REQUEST_APPROVAL");
  const deadline = actions.find((a) => a.deadline)?.deadline ?? trip.deadline;
  const committed = trip.components.filter((c) => c.state === "CONFIRMED").length;
  const refused = [...(trip.decisions ?? [])].reverse().find((d) => d.outcome === "REFUSE" && (d.gate === "COMMIT" || d.gate === "PREPARE"));

  let headline: ReactNode;
  let explain: ReactNode;
  switch (trip.state) {
    case "PREPARING":
      headline = "Checking each supplier";
      explain = "Intyr is asking each supplier for a current price and, where the supplier allows it, a hold. Nothing is booked yet.";
      break;
    case "REVALIDATING":
      headline = "Rechecking prices";
      explain = "Current prices are being compared with the manifest. Nothing is booked.";
      break;
    case "PREPARED":
    case "PREPARED_WITH_WARNINGS":
    case "READY_TO_COMMIT":
      if (refused && !commit?.allowed) {
        headline = "Intyr will not commit this trip";
        explain = `${describeReason(refused.reason_codes?.[0] ?? commit?.reason ?? "POLICY_DENIED")} Nothing was booked. Prepare a different trip or change its limits.`;
        break;
      }
      headline = trip.approval?.required ? "Needs approval before commit" : commit?.allowed ? "Ready to commit" : "Prepared";
      explain = commit?.allowed
        ? "Every leg passed its checks. Committing books the legs in the order below and confirms each one through a second read."
        : commit?.reason
          ? describeReason(commit.reason)
          : "Review the legs below before committing.";
      break;
    case "COMMITTING":
      headline = `Committing, ${committed} of ${trip.components.length} confirmed`;
      explain = "You can leave this page. The commit keeps running and this trip updates when each supplier is confirmed.";
      break;
    case "COMMIT_STATUS_UNKNOWN":
      headline = "Booking status unknown";
      explain = null;
      break;
    case "COMMITTED_UNVERIFIED":
      headline = "Committed, verifying with suppliers";
      explain = "Every supplier replied. Intyr is reading each booking back before calling the trip committed.";
      break;
    case "COMMITTED":
      headline = "Committed";
      explain = "Every leg was confirmed by a read after the booking. The receipt below can be checked by anyone.";
      break;
    case "COMMIT_NOT_EXECUTED":
      headline = "Not committed";
      explain = "Intyr refused the commit before any supplier was booked. Nothing needs to be undone.";
      break;
    case "RECOVERING":
      headline = "Recovering";
      explain = "A leg failed after others were booked. Intyr is cancelling or replacing legs inside the limits set before payment.";
      break;
    case "RECOVERED":
      headline = "Recovered";
      explain = "Every leg ended in a consistent state: either kept, cancelled or replaced inside the agreed limits.";
      break;
    case "RECOVERY_FAILED":
      headline = "Recovery failed";
      explain = "Some legs could not be undone or replaced. The legs below show exactly what is still booked.";
      break;
    case "MANUAL_REVIEW":
      headline = "Needs a person to decide";
      explain = "Automation stopped because the next step needs judgment. The decision log explains what is being asked.";
      break;
    case "PREPARATION_FAILED":
      headline = "Preparation failed";
      explain = "No supplier was booked. The decision log explains which leg failed.";
      break;
    case "CHECKED":
      headline = "Plan checked";
      explain = "This plan was evaluated from offers the agent supplied. Intyr did not call any supplier.";
      break;
    default:
      headline = state.label;
      explain = null;
  }

  return (
    <section className={`verdict verdict-${state.tone}`} aria-live="polite">
      <div className="verdict-main">
        <div className="row">
          <TripStateChip state={trip.state} />
          {trip.environment !== "MAINNET" ? <Chip tone="amber">TestNet sandbox</Chip> : null}
          {deadline && !state.terminal ? <span className="meta">Offer valid {relativeTime(deadline)?.startsWith("in ") ? `for ${relativeTime(deadline)?.slice(3)}` : `until ${formatDateTime(deadline)}`}</span> : null}
        </div>
        <h1 className="verdict-title">{headline}</h1>
        {trip.state === "COMMIT_STATUS_UNKNOWN" ? <UnknownNotice /> : explain ? <p className="verdict-explain">{explain}</p> : null}
      </div>
      <div className="verdict-actions">
        {trip.approval?.required && trip.state !== "COMMITTED" ? (
          <ButtonLink to={`/app/trips/${trip.trip_id}/approve`}>Review and approve</ButtonLink>
        ) : null}
        {commit && !trip.approval?.required && !(refused && !commit.allowed) ? (
          <Button onClick={onCommit} disabled={!commit.allowed} loading={busy === "COMMIT"} title={commit.reason ? describeReason(commit.reason) : undefined}>
            Commit trip
          </Button>
        ) : null}
        {recover ? (
          <Button variant="dark" onClick={onRecover} disabled={!recover.allowed} loading={busy === "RECOVER"}>
            Run recovery
          </Button>
        ) : null}
        {revalidate ? (
          <Button variant="secondary" onClick={onRevalidate} disabled={!revalidate.allowed} loading={busy === "REVALIDATE"}>
            Recheck prices
          </Button>
        ) : null}
        {approval && !trip.approval?.required ? <span className="meta">{describeReason(approval.reason ?? "APPROVAL_REQUIRED")}</span> : null}
        {trip.manifest_id && ["COMMITTED", "RECOVERED", "RECOVERY_FAILED", "COMMIT_NOT_EXECUTED"].includes(trip.state) ? (
          <ButtonLink to={`/verify/${trip.manifest_id}`} variant="secondary">
            <FileCheck2 aria-hidden size={16} /> View receipt
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
        <dt>Protection</dt>
        <dd>None in this release. No bond, insurance or guarantee backs this trip.</dd>
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
