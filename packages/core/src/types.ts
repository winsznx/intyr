import type { Clocks, Money } from "./schema";
import type {
  ActorType,
  AnchorMode,
  ComponentState,
  ComponentType,
  DecisionOutcome,
  Environment,
  EvidenceBanner,
  EvidenceGrade,
  EvidenceTier,
  Gate,
  LegClass,
  ManifestStatus,
  OutcomeVerification,
  PaymentSessionState,
  PayerClass,
  PlanVerdict,
  PreparationMode,
  ReasonCode,
  ReviewAuthority,
  SimulatedFault,
  TripState,
} from "./vocab";

export type { Clocks, Money };

export interface NextAction {
  action: "CHECK" | "PREPARE" | "REVALIDATE" | "COMMIT" | "RECOVER" | "REQUEST_APPROVAL" | "POLL" | "VERIFY" | "CLOSE";
  allowed: boolean;
  reason?: ReasonCode;
  recommended_before?: string;
}

export interface EvidenceRef {
  kind: string;
  hash: string;
  uri?: string;
}

/** Decision Primitive record (D1 section 2). Append-only and hash-chained per subject. */
export interface GateDecision {
  decision_id: string;
  gate: Gate;
  subject: { trip_id?: string; component_id?: string; session_id?: string; plan_id?: string };
  outcome: DecisionOutcome;
  reason_codes: ReasonCode[];
  evidence_refs: EvidenceRef[];
  inputs_hash: string;
  policy_version: string;
  kernel_version: string;
  next_actions: NextAction[];
  reconcile_by?: string;
  required_role?: ReviewAuthority;
  decided_by: { actor_type: ActorType; actor_id: string };
  decided_at: string;
  prev_decision_hash?: string;
  decision_hash: string;
}

/** A leg as Intyr evaluates it, whichever class supplied it. */
export interface Leg {
  leg_id: string;
  type: ComponentType;
  leg_class: LegClass;
  supplier: string;
  offer_ref: string;
  price: Money;
  preparation_mode: PreparationMode;
  refundable: boolean;
  cancellation_fee_minor?: number;
  clocks: Clocks;
  depends_on: string[];
  required: boolean;
  evidence_grade: EvidenceGrade;
}

/** 0 free to undo, 1 undo possible at a cost or inside a void window, 2 cannot be undone. */
export type ReversibilityClass = 0 | 1 | 2;

export interface PlannedLeg {
  leg_id: string;
  order_index: number;
  hold_strength: PreparationMode;
  reversibility: ReversibilityClass;
  irreversible: boolean;
  readiness_score: number;
  score_parts: { firmness: number; time: number; reversibility: number; confirmation: number };
  earliest_expiry?: string;
  reasons: ReasonCode[];
}

export interface Readiness {
  score: number;
  validated: false;
  model_version: string;
  basis: "PRIOR";
  minimum_required: number;
}

export interface Exposure {
  total_minor: number;
  irreversible_minor: number;
  currency: string;
}

export interface RetryPolicy {
  do_not_retry_on: string[];
  reconcile_with: string;
}

/** Signed result of POST /v1/trips/check. It reports; it books nothing. */
export interface CommitPlan {
  schema_version: "commit-plan/1";
  plan_id: string;
  trip_ref?: string;
  environment: Environment;
  created_at: string;
  valid_until?: string;
  currency: string;
  legs: PlannedLeg[];
  commit_order: string[];
  verdict: PlanVerdict;
  decision: GateDecision;
  readiness: Readiness;
  exposure: Exposure;
  retry_policy: RetryPolicy;
  assurance: { mode: "NONE" };
  inputs_hash: string;
}

export interface ComponentConfirmation {
  supplier_ref_hash: string;
  postcondition_hash: string;
  read_path: string;
  read_at: string;
  evidence_tier: EvidenceTier;
}

export interface ManifestComponent {
  component_id: string;
  leg_id: string;
  type: ComponentType;
  leg_class: LegClass;
  adapter_id: string;
  adapter_version: string;
  supplier: string;
  preparation_mode: PreparationMode;
  state: ComponentState;
  price: Money;
  clocks: Clocks;
  irreversible: boolean;
  evidence_grade: EvidenceGrade;
  supplier_mode: "TEST" | "SANDBOX" | "SIMULATED" | "LIVE";
  request_hash?: string;
  response_hash?: string;
  confirmation?: ComponentConfirmation;
  outcome_verification?: OutcomeVerification;
  /** Faults injected into this component and the seed that reproduces them. Empty for a real supplier leg. */
  synthetic_faults: Array<{ fault: SimulatedFault; seed: string; source: "proxy" | "supplier_vector" }>;
}

export interface PaymentRef {
  session_id: string;
  route: string;
  network: string;
  asset_id: number;
  amount_minor: number;
  pay_to: string;
  payer: string;
  payer_class: PayerClass;
  txid: string;
  state: PaymentSessionState;
  confirmed_round?: number;
}

export interface AnchorRef {
  mode: AnchorMode;
  network: string;
  txid: string;
  confirmed_round?: number;
  note_prefix: string;
}

/**
 * The signed document an agent reviews before commit (prepare, revalidate).
 * Mutable status lives in a separate ManifestStatusRecord, never in here.
 */
export interface CommitManifest {
  schema_version: "commit-manifest/1";
  manifest_id: string;
  trip_id: string;
  environment: Environment;
  created_at: string;
  expires_at: string;
  supersedes?: string;
  intent_hash: string;
  currency: string;
  total_minor: number;
  components: ManifestComponent[];
  component_root: string;
  commit_order: string[];
  readiness: Readiness;
  exposure: Exposure;
  decision_log_root: string;
  non_actions: Array<{ gate: Gate; reason: ReasonCode; subject: string }>;
  recovery_policy: {
    policy_version: string;
    replacement_headroom_minor: number;
    cancel_reversible_on_failure: true;
    never_replace_while_unknown: true;
  };
  assurance: { mode: "NONE" };
  evidence_banner: EvidenceBanner;
  inbound_payments: PaymentRef[];
}

/** Final record after commit or recovery. Links money, supplier truth, decisions and anchors. */
export interface TransactionManifest {
  schema_version: "transaction-manifest/1";
  manifest_id: string;
  trip_id: string;
  environment: Environment;
  created_at: string;
  commit_manifest_hash: string;
  final_state: TripState;
  components: ManifestComponent[];
  component_root: string;
  decisions_root: string;
  decisions: Array<Pick<GateDecision, "decision_id" | "gate" | "outcome" | "reason_codes" | "decision_hash">>;
  non_actions: Array<{ gate: Gate; reason: ReasonCode; subject: string }>;
  inbound_payments: PaymentRef[];
  outbound_payments: PaymentRef[];
  anchors: AnchorRef[];
  stranded_spend_minor: number;
  assurance: { mode: "NONE" };
  evidence_banner: EvidenceBanner;
}

export interface ManifestStatusRecord {
  schema_version: "manifest-status/1";
  manifest_id: string;
  manifest_hash: string;
  status: ManifestStatus;
  superseded_by?: string;
  at: string;
}
