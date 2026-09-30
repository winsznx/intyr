import { makeDecision } from "./decision";
import { newId } from "./ids";
import { effectivePolicy, PUBLIC_DEFAULT_POLICY, type Policy } from "./policy";
import type { CallerLeg, CheckRequest, Clocks, Money } from "./schema";
import { signDocument, type Signed, type SigningKey } from "./sign";
import type { CommitPlan, Exposure, GateDecision, Leg, NextAction, PlannedLeg, Readiness, ReversibilityClass } from "./types";
import type {
  ComponentType,
  DecisionOutcome,
  Environment,
  EvidenceGrade,
  LegClass,
  PlanVerdict,
  PreparationMode,
  ReasonCode,
} from "./vocab";

export const READINESS_MODEL_VERSION = "readiness-0.1.0";

const FIRMNESS: Record<PreparationMode, number> = {
  HARD_HOLD: 100,
  SOFT_HOLD: 75,
  REVALIDATED: 55,
  INSTANT_COMMIT_ONLY: 35,
  UNSUPPORTED: 0,
};
const REVERSIBILITY_SCORE: Record<ReversibilityClass, number> = { 0: 100, 1: 60, 2: 20 };
const CONFIRMATION_SCORE = { INSTANT: 100, ASYNC: 60, MANUAL: 40 } as const;
/** Weights of the readiness score. Provider history is excluded until observed outcomes exist (basis PRIOR). */
const WEIGHTS = { firmness: 0.4, time: 0.25, reversibility: 0.2, confirmation: 0.15 } as const;
const FULL_TIME_SCORE_MINUTES = 30;

export const DO_NOT_RETRY_ON = ["HTTP_202_ACCEPTED", "HTTP_200_NOT_YET_CREATED", "TIMEOUT", "HTTP_5XX_STATUS_UNKNOWN"];
const RECONCILE_WITH =
  "Read the supplier order by reference and by offer id before any retry. A timeout is an unknown outcome, not a failure.";

function ms(iso: string | null): number | undefined {
  return iso === null ? undefined : Date.parse(iso);
}

export function legFromCaller(leg: CallerLeg): Leg {
  return { ...leg, leg_class: "CALLER_SUPPLIED", evidence_grade: "CALLER_ASSERTED" };
}

/**
 * The fields of an adapter's PreparedLeg that the planner reads. Declared
 * structurally so core never depends on the adapters package.
 */
export interface PreparedLegInput {
  component_id: string;
  type: ComponentType;
  leg_class: LegClass;
  evidence_grade: EvidenceGrade;
  provider_id: string;
  preparation_mode: PreparationMode;
  refs: { offer_id: string | null };
  price: Money;
  clocks: Clocks;
  irreversible: boolean;
}

export function legFromPrepared(
  leg: PreparedLegInput,
  options: { required?: boolean; depends_on?: string[]; cancellation_fee_minor?: number } = {},
): Leg {
  return {
    leg_id: leg.component_id,
    type: leg.type,
    leg_class: leg.leg_class,
    supplier: leg.provider_id,
    offer_ref: leg.refs.offer_id ?? "",
    price: leg.price,
    preparation_mode: leg.preparation_mode,
    refundable: !leg.irreversible,
    ...(options.cancellation_fee_minor !== undefined ? { cancellation_fee_minor: options.cancellation_fee_minor } : {}),
    clocks: leg.clocks,
    depends_on: options.depends_on ?? [],
    required: options.required ?? true,
    evidence_grade: leg.evidence_grade,
  };
}

/** Earliest moment the price or the held inventory stops being valid. */
export function earliestExpiry(leg: Leg): number | undefined {
  const candidates = [ms(leg.clocks.price_valid_until), ms(leg.clocks.inventory_held_until)].filter(
    (v): v is number => v !== undefined,
  );
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

/** How far a leg can be undone after it is committed. */
export function reversibilityOf(leg: Leg, now: Date): ReversibilityClass {
  const t = now.getTime();
  const freeUntil = ms(leg.clocks.free_cancel_until);
  if (leg.refundable && freeUntil !== undefined && freeUntil > t && (leg.cancellation_fee_minor ?? 0) === 0) return 0;
  const voidUntil = ms(leg.clocks.void_until);
  if (voidUntil !== undefined && voidUntil > t) return 1;
  if (leg.refundable) return 1;
  return 2;
}

export function scoreLeg(leg: Leg, now: Date): { score: number; parts: PlannedLeg["score_parts"] } {
  const expiry = earliestExpiry(leg);
  const minutesLeft = expiry === undefined ? 0 : (expiry - now.getTime()) / 60_000;
  const parts = {
    firmness: FIRMNESS[leg.preparation_mode],
    time: Math.max(0, Math.min(100, Math.round((100 * minutesLeft) / FULL_TIME_SCORE_MINUTES))),
    reversibility: REVERSIBILITY_SCORE[reversibilityOf(leg, now)],
    confirmation: CONFIRMATION_SCORE[leg.clocks.confirmation_mode],
  };
  const score = Math.round(
    parts.firmness * WEIGHTS.firmness +
      parts.time * WEIGHTS.time +
      parts.reversibility * WEIGHTS.reversibility +
      parts.confirmation * WEIGHTS.confirmation,
  );
  return { score, parts };
}

/** Dependency depth per leg, or null when a dependency is unknown or cyclic. */
function dependencyDepths(legs: Leg[]): Map<string, number> | null {
  const byId = new Map(legs.map((l) => [l.leg_id, l]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number | null => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const leg = byId.get(id);
    if (!leg || visiting.has(id)) return null;
    visiting.add(id);
    let d = 0;
    for (const dep of leg.depends_on) {
      const dd = visit(dep);
      if (dd === null) return null;
      d = Math.max(d, dd + 1);
    }
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const leg of legs) if (visit(leg.leg_id) === null) return null;
  return depth;
}

/**
 * Commit order: dependencies first, then reversible before irreversible, then
 * whatever expires soonest, then smaller exposure, then id for a stable tie-break.
 * Anyone holding the legs can recompute the same order.
 */
export function orderLegs(legs: Leg[], now: Date): Leg[] | null {
  const depths = dependencyDepths(legs);
  if (!depths) return null;
  const key = (l: Leg) => [
    depths.get(l.leg_id) ?? 0,
    reversibilityOf(l, now),
    earliestExpiry(l) ?? Number.MAX_SAFE_INTEGER,
    l.price.amount_minor,
  ];
  return [...legs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i]! !== kb[i]!) return ka[i]! - kb[i]!;
    return a.leg_id < b.leg_id ? -1 : a.leg_id > b.leg_id ? 1 : 0;
  });
}

export function exposureOf(legs: Leg[], now: Date, currency: string): Exposure {
  let total = 0;
  let irreversible = 0;
  for (const leg of legs) {
    if (!leg.required) continue;
    total += leg.price.amount_minor;
    const cls = reversibilityOf(leg, now);
    if (cls === 2) irreversible += leg.price.amount_minor;
    else if (cls === 1) irreversible += leg.cancellation_fee_minor ?? 0;
  }
  return { total_minor: total, irreversible_minor: irreversible, currency };
}

export const PLAN_VERDICT_OF: Record<DecisionOutcome, PlanVerdict> = {
  ACT: "COMMIT_NOW",
  UNKNOWN: "REVALIDATE_FIRST",
  MANUAL_REVIEW: "NEEDS_APPROVAL",
  REFUSE: "DO_NOT_COMMIT",
  NO_ACTION: "DO_NOT_COMMIT",
};

interface Verdict {
  outcome: DecisionOutcome;
  reasons: ReasonCode[];
}

function evaluate(legs: Leg[], currency: string, policy: Policy, now: Date, readiness: number, exposure: Exposure): Verdict {
  const required = legs.filter((l) => l.required);
  if (legs.some((l) => l.price.currency !== currency)) return { outcome: "REFUSE", reasons: ["CURRENCY_MISMATCH"] };
  if (new Set(legs.map((l) => l.leg_id)).size !== legs.length) return { outcome: "REFUSE", reasons: ["DUPLICATE_LEG_ID"] };
  if (dependencyDepths(legs) === null) return { outcome: "REFUSE", reasons: ["UNKNOWN_DEPENDENCY"] };
  if (required.some((l) => l.preparation_mode === "UNSUPPORTED")) {
    return { outcome: "REFUSE", reasons: ["UNSUPPORTED_PREPARATION_MODE"] };
  }
  if (policy.max_total_minor !== undefined && exposure.total_minor > policy.max_total_minor) {
    return { outcome: "REFUSE", reasons: ["BUDGET_EXCEEDED"] };
  }
  if (required.some((l) => earliestExpiry(l) === undefined)) return { outcome: "UNKNOWN", reasons: ["MISSING_PRICE_VALIDITY"] };
  if (required.some((l) => earliestExpiry(l)! <= now.getTime())) {
    return { outcome: "UNKNOWN", reasons: ["PRICE_VALIDITY_EXPIRED"] };
  }
  if (policy.max_irreversible_minor !== undefined && exposure.irreversible_minor > policy.max_irreversible_minor) {
    return { outcome: "REFUSE", reasons: ["IRREVERSIBLE_EXPOSURE_ABOVE_CAP"] };
  }
  if (required.some((l) => earliestExpiry(l)! - now.getTime() < policy.near_expiry_seconds * 1000)) {
    return { outcome: "UNKNOWN", reasons: ["PRICE_VALIDITY_NEAR_EXPIRY"] };
  }
  if (readiness < policy.min_readiness) return { outcome: "REFUSE", reasons: ["READINESS_BELOW_THRESHOLD"] };
  if (exposure.irreversible_minor > policy.autonomous_irreversible_cap_minor) {
    return { outcome: "MANUAL_REVIEW", reasons: ["IRREVERSIBLE_EXPOSURE_ABOVE_CAP"] };
  }
  return { outcome: "ACT", reasons: ["ALL_CHECKS_PASSED"] };
}

function nextActionsFor(outcome: DecisionOutcome, reasons: ReasonCode[], recommendedBefore?: string): NextAction[] {
  switch (outcome) {
    case "ACT":
      return [{ action: "COMMIT", allowed: true, ...(recommendedBefore ? { recommended_before: recommendedBefore } : {}) }];
    case "UNKNOWN":
      return [
        { action: "COMMIT", allowed: false, reason: reasons[0]! },
        { action: "REVALIDATE", allowed: true },
      ];
    case "MANUAL_REVIEW":
      return [
        { action: "COMMIT", allowed: false, reason: "APPROVAL_REQUIRED" },
        { action: "REQUEST_APPROVAL", allowed: true },
      ];
    default:
      return [
        { action: "COMMIT", allowed: false, reason: reasons[0]! },
        { action: "CHECK", allowed: true },
      ];
  }
}

/** Everything the planner concludes about a set of legs, before it is wrapped in a decision. */
export interface Assessment {
  legs: PlannedLeg[];
  commit_order: string[];
  exposure: Exposure;
  readiness: Readiness;
  outcome: DecisionOutcome;
  reasons: ReasonCode[];
  next_actions: NextAction[];
  valid_until?: string;
}

/**
 * Scores, orders and evaluates legs against a policy that is already
 * effective. Shared by check (caller legs) and prepare or revalidate
 * (adapter legs), so both paths reach the same verdict for the same inputs.
 */
export function assessLegs(legs: Leg[], currency: string, policy: Policy, now: Date): Assessment {
  const ordered = orderLegs(legs, now) ?? legs;
  const exposure = exposureOf(legs, now, currency);

  const planned: PlannedLeg[] = ordered.map((leg, index) => {
    const { score, parts } = scoreLeg(leg, now);
    const expiry = earliestExpiry(leg);
    const reasons: ReasonCode[] = [];
    if (expiry === undefined) reasons.push("MISSING_PRICE_VALIDITY");
    else if (expiry <= now.getTime()) reasons.push("PRICE_VALIDITY_EXPIRED");
    else if (expiry - now.getTime() < policy.near_expiry_seconds * 1000) reasons.push("PRICE_VALIDITY_NEAR_EXPIRY");
    if (leg.preparation_mode === "UNSUPPORTED") reasons.push("UNSUPPORTED_PREPARATION_MODE");
    const reversibility = reversibilityOf(leg, now);
    return {
      leg_id: leg.leg_id,
      order_index: index,
      hold_strength: leg.preparation_mode,
      reversibility,
      irreversible: reversibility === 2,
      readiness_score: score,
      score_parts: parts,
      ...(expiry !== undefined ? { earliest_expiry: new Date(expiry).toISOString() } : {}),
      reasons,
    };
  });

  const requiredIds = new Set(legs.filter((l) => l.required).map((l) => l.leg_id));
  const requiredScores = planned.filter((p) => requiredIds.has(p.leg_id)).map((p) => p.readiness_score);
  const readinessScore = requiredScores.length === 0 ? 0 : Math.min(...requiredScores);
  const verdict = evaluate(legs, currency, policy, now, readinessScore, exposure);
  const validUntil = planned
    .map((p) => p.earliest_expiry)
    .filter((v): v is string => v !== undefined)
    .sort()[0];

  return {
    legs: planned,
    commit_order: planned.map((p) => p.leg_id),
    exposure,
    readiness: {
      score: readinessScore,
      validated: false,
      model_version: READINESS_MODEL_VERSION,
      basis: "PRIOR",
      minimum_required: policy.min_readiness,
    },
    outcome: verdict.outcome,
    reasons: verdict.reasons,
    next_actions: nextActionsFor(verdict.outcome, verdict.reasons, validUntil),
    ...(validUntil ? { valid_until: validUntil } : {}),
  };
}

function decisionExtras(outcome: DecisionOutcome, now: Date) {
  return {
    ...(outcome === "UNKNOWN" ? { reconcile_by: now.toISOString() } : {}),
    ...(outcome === "MANUAL_REVIEW" ? { required_role: "SESSION_APPROVER" as const } : {}),
  };
}

export interface PlanContext {
  now: Date;
  environment: Environment;
  policy?: Policy;
}

/**
 * Evaluates caller-supplied legs and returns the commit plan: order by
 * reversibility, hold strength, readiness, exposure and a COMMIT gate decision.
 * It performs no supplier call and books nothing.
 */
export async function planTrip(request: CheckRequest, ctx: PlanContext): Promise<CommitPlan> {
  const policy = effectivePolicy(ctx.policy ?? PUBLIC_DEFAULT_POLICY, request.limits);
  const assessment = assessLegs(request.legs.map(legFromCaller), request.currency, policy, ctx.now);
  const planId = newId("pln");
  const inputs = { request, policy, now: ctx.now.toISOString(), environment: ctx.environment };

  const decision = await makeDecision({
    gate: "COMMIT",
    subject: { plan_id: planId },
    outcome: assessment.outcome,
    reason_codes: assessment.reasons,
    inputs,
    policy_version: policy.policy_version,
    next_actions: assessment.next_actions,
    ...decisionExtras(assessment.outcome, ctx.now),
    now: ctx.now,
  });

  return {
    schema_version: "commit-plan/1",
    plan_id: planId,
    ...(request.trip_ref ? { trip_ref: request.trip_ref } : {}),
    environment: ctx.environment,
    created_at: ctx.now.toISOString(),
    ...(assessment.valid_until ? { valid_until: assessment.valid_until } : {}),
    currency: request.currency,
    legs: assessment.legs,
    commit_order: assessment.commit_order,
    verdict: PLAN_VERDICT_OF[assessment.outcome],
    decision,
    readiness: assessment.readiness,
    exposure: assessment.exposure,
    retry_policy: { do_not_retry_on: DO_NOT_RETRY_ON, reconcile_with: RECONCILE_WITH },
    assurance: { mode: "NONE" },
    inputs_hash: decision.inputs_hash,
  };
}

/** Plan plus Ed25519 signature in the `intyr/plan/v1` context. */
export async function checkTrip(request: CheckRequest, ctx: PlanContext & { key: SigningKey }): Promise<Signed<CommitPlan>> {
  return signDocument(ctx.key, "intyr/plan/v1", await planTrip(request, ctx));
}

export interface PrepareGateInput {
  trip_id: string;
  currency: string;
  legs: Leg[];
  /** Already effective: base policy tightened by the request limits and budget. */
  policy: Policy;
  now: Date;
  prev_decision_hash?: string;
}

/**
 * PREPARE gate for prepared or revalidated legs. Its assessment feeds the
 * commit manifest (order, readiness, exposure) and its outcome decides whether
 * the trip is offered for commit.
 */
export async function decidePrepare(input: PrepareGateInput): Promise<{ assessment: Assessment; decision: GateDecision }> {
  const assessment = assessLegs(input.legs, input.currency, input.policy, input.now);
  const decision = await makeDecision({
    gate: "PREPARE",
    subject: { trip_id: input.trip_id },
    outcome: assessment.outcome,
    reason_codes: assessment.reasons,
    inputs: { legs: input.legs, currency: input.currency, policy: input.policy, now: input.now },
    policy_version: input.policy.policy_version,
    next_actions: assessment.next_actions,
    ...decisionExtras(assessment.outcome, input.now),
    ...(input.prev_decision_hash ? { prev_decision_hash: input.prev_decision_hash } : {}),
    now: input.now,
  });
  return { assessment, decision };
}
