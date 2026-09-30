import { canonicalize } from "./canonical";
import { hashValue } from "./hash";
import { newId } from "./ids";
import type { EvidenceRef, GateDecision, NextAction } from "./types";
import type { ActorType, DecisionOutcome, Gate, ReasonCode, ReviewAuthority } from "./vocab";

export const KERNEL_VERSION = "kernel-0.1.0";

export interface DecisionInput {
  gate: Gate;
  subject: GateDecision["subject"];
  outcome: DecisionOutcome;
  reason_codes: ReasonCode[];
  /** Everything the gate looked at. Hashed so anyone holding the inputs can replay the verdict. */
  inputs: unknown;
  policy_version: string;
  next_actions?: NextAction[];
  evidence_refs?: EvidenceRef[];
  reconcile_by?: string;
  required_role?: ReviewAuthority;
  decided_by?: { actor_type: ActorType; actor_id: string };
  prev_decision_hash?: string;
  now: Date;
}

/**
 * Gate inputs pass through JSON before hashing, so a Date hashes as its ISO
 * string and an optional field set to undefined hashes the same as an omitted one.
 */
function jsonNormalized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

export class DecisionShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionShapeError";
  }
}

/**
 * Builds a GateDecision. Enforces the D1 rules that make inaction auditable:
 * every non-ACT outcome names a reason, UNKNOWN names a reconcile deadline and
 * MANUAL_REVIEW names who must decide.
 */
export async function makeDecision(input: DecisionInput): Promise<GateDecision> {
  if (input.outcome !== "ACT" && input.reason_codes.length === 0) {
    throw new DecisionShapeError(`${input.gate}: ${input.outcome} requires at least one reason code`);
  }
  if (input.outcome === "UNKNOWN" && !input.reconcile_by) {
    throw new DecisionShapeError(`${input.gate}: UNKNOWN requires reconcile_by`);
  }
  if (input.outcome === "MANUAL_REVIEW" && !input.required_role) {
    throw new DecisionShapeError(`${input.gate}: MANUAL_REVIEW requires required_role`);
  }

  const body: Omit<GateDecision, "decision_hash"> = {
    decision_id: newId("dec"),
    gate: input.gate,
    subject: input.subject,
    outcome: input.outcome,
    reason_codes: input.reason_codes,
    evidence_refs: input.evidence_refs ?? [],
    inputs_hash: await hashValue(canonicalize(jsonNormalized(input.inputs))),
    policy_version: input.policy_version,
    kernel_version: KERNEL_VERSION,
    next_actions: input.next_actions ?? [],
    ...(input.reconcile_by ? { reconcile_by: input.reconcile_by } : {}),
    ...(input.required_role ? { required_role: input.required_role } : {}),
    decided_by: input.decided_by ?? { actor_type: "SYSTEM", actor_id: "intyr" },
    decided_at: input.now.toISOString(),
    ...(input.prev_decision_hash ? { prev_decision_hash: input.prev_decision_hash } : {}),
  };
  return { ...body, decision_hash: await hashValue(canonicalize(body)) };
}

/** Recomputes a decision hash; false means the record was altered after it was made. */
export async function decisionIntact(decision: GateDecision): Promise<boolean> {
  const { decision_hash, ...body } = decision;
  return (await hashValue(canonicalize(body))) === decision_hash;
}

/** Checks that a subject's decisions form an unbroken chain in the given order. */
export function decisionChainIntact(decisions: GateDecision[]): boolean {
  for (let i = 1; i < decisions.length; i++) {
    if (decisions[i]!.prev_decision_hash !== decisions[i - 1]!.decision_hash) return false;
  }
  return true;
}
