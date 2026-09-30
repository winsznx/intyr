import { ApiError, type ActionResponse } from "../lib/api";
import { UNKNOWN_PAYMENT_COPY, describeReason } from "../lib/labels";
import { DecisionChip, Notice, PaymentStateChip, ReasonList, UnknownNotice } from "./ui";

export type ActionOutcome = { ok: true; action: string; response: ActionResponse } | { ok: false; action: string; error: Error };

/**
 * Explains the last action in the same terms the server used. It never upgrades an outcome:
 * a 202 or an UNKNOWN is shown as unconfirmed, a refusal as a refusal.
 */
export function ActionResult({ outcome }: { outcome: ActionOutcome | null }) {
  if (!outcome) return null;

  if (outcome.ok) {
    const { response } = outcome;
    const decision = response.decision;
    if (response.payment_state === "UNKNOWN") {
      return <Notice kind="unknown">{UNKNOWN_PAYMENT_COPY}</Notice>;
    }
    if (decision?.outcome === "UNKNOWN") return <UnknownNotice />;
    if (decision?.outcome === "REFUSE") {
      return (
        <Notice kind="refuse" title="Intyr did not do this.">
          <ReasonList codes={decision.reason_codes} />
        </Notice>
      );
    }
    if (decision?.outcome === "MANUAL_REVIEW") {
      return (
        <Notice kind="review" title="A person has to decide.">
          <ReasonList codes={decision.reason_codes} />
        </Notice>
      );
    }
    if (decision?.outcome === "NO_ACTION") {
      return (
        <Notice kind="info" title="Nothing needed doing.">
          <ReasonList codes={decision.reason_codes} />
        </Notice>
      );
    }
    return (
      <div className="row" role="status">
        <span className="meta">Request accepted.</span>
        {decision ? <DecisionChip outcome={decision.outcome} /> : null}
        {response.payment_state ? <PaymentStateChip state={response.payment_state} /> : null}
        <span className="meta">The trip below updates from the server as each step is confirmed.</span>
      </div>
    );
  }

  const error = outcome.error;
  if (!(error instanceof ApiError)) {
    return <Notice kind="danger" title="The request failed.">{error.message}</Notice>;
  }
  const body = error.body;
  const codes = body.reason_codes ?? body.decision?.reason_codes ?? (body.error ? [body.error] : []);

  if (error.unreachable) {
    return (
      <Notice kind="danger" title="The Intyr API did not answer.">
        {body.supplier_action_may_have_occurred
          ? "A supplier action may have started. Do not retry. Reload this trip in a moment to see what the server recorded."
          : "Nothing was confirmed. Reload the trip before trying again so you see what the server recorded."}
      </Notice>
    );
  }
  if (body.payment_state === "UNKNOWN") return <Notice kind="unknown">{UNKNOWN_PAYMENT_COPY}</Notice>;
  if (body.decision?.outcome === "UNKNOWN" || codes.includes("COMPONENT_STATUS_UNKNOWN")) return <UnknownNotice />;
  if (error.status === 409 && (codes.includes("MANIFEST_HASH_MISMATCH") || codes.includes("APPROVAL_EXPIRED"))) {
    return (
      <Notice kind="review" title="The manifest changed while you were looking at it.">
        {describeReason(codes[0] ?? "MANIFEST_HASH_MISMATCH")} The page now shows the current version.
      </Notice>
    );
  }
  if (error.code === "NOT_AVAILABLE" || codes.includes("ROUTE_NOT_IMPLEMENTED")) {
    return (
      <Notice kind="refuse" title="Not available in this deployment yet.">
        You were not charged and nothing was sent to a supplier.
      </Notice>
    );
  }
  return (
    <Notice kind="refuse" title="Intyr did not do this.">
      {codes.length ? <ReasonList codes={codes} /> : error.message}
    </Notice>
  );
}
