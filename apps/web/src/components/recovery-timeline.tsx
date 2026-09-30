import { Link } from "react-router";
import { formatDateTime } from "../lib/format";
import { COMPONENT_TYPE, describeReason } from "../lib/labels";
import { recoverySentence } from "../lib/recovery";
import type { GateDecision, Trip } from "../lib/types";
import { DecisionChip, TripStateChip } from "./ui";

interface Step {
  key: string;
  phase: "Detect" | "Act" | "Record";
  what: string;
  decision?: GateDecision;
  at?: string;
}

function legName(trip: Trip, componentId: string | undefined): string {
  const c = trip.components.find((x) => x.component_id === componentId);
  return c ? (COMPONENT_TYPE[c.type] ?? c.type) : "A leg";
}

/** Ordered story of a recovery, built only from the decision log and the final record. */
export function recoverySteps(trip: Trip): Step[] {
  const decisions = [...(trip.decisions ?? [])].sort((a, b) => (a.decided_at ?? "").localeCompare(b.decided_at ?? ""));
  const steps: Step[] = [];
  const failure = decisions.find((d) => d.gate === "COMPONENT_CONFIRM" && (d.outcome === "REFUSE" || d.outcome === "UNKNOWN"));
  if (failure) {
    steps.push({
      key: failure.decision_id,
      phase: "Detect",
      what: `${legName(trip, failure.subject?.component_id)}: ${describeReason(failure.reason_codes?.[0] ?? "SUPPLIER_REJECTED")}`,
      decision: failure,
      at: failure.decided_at,
    });
  }
  for (const d of decisions.filter((x) => x.gate === "RECOVERY_ACTION")) {
    steps.push({
      key: d.decision_id,
      phase: "Act",
      what: `${legName(trip, d.subject?.component_id)}: ${describeReason(d.reason_codes?.[0] ?? "")}`,
      decision: d,
      at: d.decided_at,
    });
  }
  if (trip.final_manifest_id) {
    steps.push({ key: "record", phase: "Record", what: "Signed the final record of every payment, decision and supplier outcome." });
  }
  return steps;
}

export function RecoveryTimeline({ trip }: { trip: Trip }) {
  const hasRecovery = (trip.decisions ?? []).some((d) => d.gate === "RECOVERY_ACTION");
  if (!hasRecovery) return null;
  const steps = recoverySteps(trip);
  return (
    <section className="card recovery" aria-labelledby="recovery-title" data-role="recovery-timeline">
      <div className="card-head">
        <h2 className="card-title" id="recovery-title">
          Recovery
        </h2>
        <TripStateChip state={trip.state} />
      </div>
      <p className="recovery-lead">{recoverySentence(trip)}</p>
      <ol className="recovery-steps">
        {steps.map((step) => (
          <li key={step.key} data-phase={step.phase}>
            <span className="recovery-phase">{step.phase}</span>
            <span className="recovery-what">{step.what}</span>
            <span className="recovery-meta">
              {step.decision ? <DecisionChip outcome={step.decision.outcome} /> : null}
              {step.at ? <span className="meta num">{formatDateTime(step.at)}</span> : null}
              {step.phase === "Record" && trip.final_manifest_id ? (
                <Link className="link small" to={`/verify/${trip.final_manifest_id}`}>
                  Open proof
                </Link>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
