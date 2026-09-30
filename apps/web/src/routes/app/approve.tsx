import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ActionResult, type ActionOutcome } from "../../components/action-result";
import { AppBar } from "../../components/shell";
import { TripRails } from "../../components/trip-rails";
import { Button, ButtonLink, ErrorState, HashText, Notice, ReasonList, Skeleton, TripStateChip } from "../../components/ui";
import { ApiError, api } from "../../lib/api";
import { formatDateTime, formatMoney, relativeTime } from "../../lib/format";
import { COMPONENT_TYPE } from "../../lib/labels";
import { approvalState } from "../../lib/recovery";
import type { Trip } from "../../lib/types";
import { useResource } from "../../lib/use-resource";

function approvalReasons(trip: Trip): string[] {
  const review = [...(trip.decisions ?? [])].reverse().find((d) => d.outcome === "MANUAL_REVIEW");
  return review?.reason_codes ?? trip.approval?.reason_codes ?? ["APPROVAL_REQUIRED"];
}

export function ApprovePage() {
  const { tripId = "" } = useParams();
  const navigate = useNavigate();
  const trip = useResource(`approve:${tripId}`, (signal) => api.getTrip(tripId, signal));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"APPROVE" | "REJECT" | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const decide = async (decision: "APPROVE" | "REJECT") => {
    const current = trip.data;
    if (!current?.manifest_hash) return;
    setBusy(decision);
    setOutcome(null);
    try {
      await api.approveTrip(current.trip_id, { manifest_hash: current.manifest_hash, decision, ...(note.trim() ? { note: note.trim() } : {}) });
      navigate(`/app/trips/${current.trip_id}`);
    } catch (error) {
      setOutcome({ ok: false, action: decision, error: error instanceof Error ? error : new Error(String(error)) });
      if (error instanceof ApiError && error.status === 409) trip.reload();
    } finally {
      setBusy(null);
    }
  };

  const crumbs = [
    { label: "Trips", to: "/app" },
    { label: trip.data?.label ?? tripId, to: `/app/trips/${tripId}` },
    { label: "Approve" },
  ];

  if (!trip.loaded) {
    return (
      <>
        <AppBar crumbs={crumbs} />
        <div className="app-content stack" aria-busy="true">
          <Skeleton width={300} height={28} />
          <Skeleton height={200} />
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
  const irreversible = t.components.filter((c) => c.irreversible);
  const irreversibleTotal = irreversible.reduce((sum, c) => sum + (c.price?.amount_minor ?? 0), 0);
  const currency = t.total?.currency ?? "USD";
  const expires = t.deadline ? relativeTime(t.deadline) : null;
  const pending = approvalState(t) === "NEEDED";

  return (
    <>
      <AppBar crumbs={crumbs} />
      <div className="app-content approve-layout">
        <section className="sheet-panel" aria-labelledby="approve-title">
          <div className="row">
            <TripStateChip state={t.state} />
            {expires ? <span className="meta">Offer expires {expires}</span> : null}
          </div>
          <h1 className="verdict-title" id="approve-title">
            {pending ? "Approve this trip before it is booked" : "No approval is pending"}
          </h1>
          {pending ? (
            <>
              <p className="muted">
                Intyr stopped before booking because the trip crossed a limit that needs a person. Your decision applies only to the exact manifest below.
                If anything in it changes, this approval stops working and you are asked again.
              </p>
              <div className="stack">
                <h2 className="card-title">Why approval is needed</h2>
                <ReasonList codes={approvalReasons(t)} />
              </div>
            </>
          ) : (
            <p className="muted">
              {approvalState(t) === "GIVEN" ? "This manifest is already approved. Go back to the trip to commit it." : "Nothing to approve on this trip. Go back to the trip to see its current state."}
            </p>
          )}

          <dl className="kv">
            <dt>Trip total</dt>
            <dd className="num">{formatMoney(t.total)}</dd>
            <dt>Maximum allowed</dt>
            <dd className="num">{t.maximum_total ? formatMoney(t.maximum_total) : "Not set"}</dd>
            <dt>Cannot be undone</dt>
            <dd>
              {irreversible.length
                ? `${irreversible.map((c) => c.label ?? COMPONENT_TYPE[c.type] ?? c.type).join(", ")} (${formatMoney({ amount_minor: irreversibleTotal, currency })})`
                : "Nothing. Every leg can be cancelled under its supplier terms."}
            </dd>
            <dt>Protection</dt>
            <dd>None in this release.</dd>
            <dt>Offer valid until</dt>
            <dd>{formatDateTime(t.deadline)}</dd>
            <dt>Approving manifest</dt>
            <dd>{t.manifest_hash ? <HashText value={t.manifest_hash} label="manifest hash" /> : "Missing"}</dd>
          </dl>

          {pending ? (
            <>
              <label className="field">
                <span className="field-label">Note for the record (optional)</span>
                <textarea className="input" rows={3} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} />
                <span className="field-hint">Stored with your decision in the trip's decision log.</span>
              </label>
              <ActionResult outcome={outcome} />
              <div className="approve-actions">
                <Button variant="secondary" onClick={() => void decide("REJECT")} loading={busy === "REJECT"} disabled={busy !== null || !t.manifest_hash}>
                  Reject
                </Button>
                <Button onClick={() => void decide("APPROVE")} loading={busy === "APPROVE"} disabled={busy !== null || !t.manifest_hash}>
                  Approve this manifest
                </Button>
              </div>
              <Notice kind="info">
                Only a person in this browser session can approve. Intyr never gives the approval link to the agent that asked for the trip.
              </Notice>
            </>
          ) : (
            <ButtonLink to={`/app/trips/${t.trip_id}`}>Back to the trip</ButtonLink>
          )}
        </section>

        <section className="card" aria-labelledby="approve-legs">
          <div className="card-head">
            <h2 className="card-title" id="approve-legs">
              What you are approving
            </h2>
          </div>
          <div className="card-pad">
            <TripRails components={t.components} compact />
          </div>
        </section>
      </div>
    </>
  );
}
