/*
 * Hand-written response shapes for the R0 API, following the canonical vocabulary
 * (internal decision D4) and the contract agreed with apps/api. They are replaced by
 * imports from packages/schema once that package exists. Fields the server may omit
 * are optional so the UI renders what it receives instead of inventing values.
 */

export type Environment = "MAINNET" | "TESTNET";

export type DecisionOutcome = "ACT" | "NO_ACTION" | "UNKNOWN" | "REFUSE" | "MANUAL_REVIEW";

export type Gate = "PAYMENT_ACCEPT" | "PREPARE" | "COMMIT" | "COMPONENT_CONFIRM" | "RECOVERY_ACTION" | "REFUND";

export type TripState =
  | "DRAFT"
  | "CHECKED"
  | "PREPARING"
  | "PREPARED"
  | "PREPARED_WITH_WARNINGS"
  | "PREPARATION_FAILED"
  | "REVALIDATING"
  | "READY_TO_COMMIT"
  | "COMMITTING"
  | "COMMIT_STATUS_UNKNOWN"
  | "COMMITTED_UNVERIFIED"
  | "COMMITTED"
  | "COMMIT_NOT_EXECUTED"
  | "RECOVERING"
  | "RECOVERED"
  | "RECOVERY_FAILED"
  | "MANUAL_REVIEW"
  | "CANCELLED"
  | "SERVICING";

export type ManifestStatus = "ACTIVE" | "SUPERSEDED" | "EXPIRED" | "REVOKED";

export type ComponentState =
  | "REQUESTED"
  | "PREPARING"
  | "PREPARED"
  | "PRICE_UNCERTAIN"
  | "UNAVAILABLE"
  | "EXPIRED"
  | "COMMIT_SUBMITTED"
  | "COMMIT_RESPONDED"
  | "CONFIRMED"
  | "COMMIT_STATUS_UNKNOWN"
  | "COMMIT_FAILED"
  | "CANCELLING"
  | "CANCELLED"
  | "RECOVERY_PENDING"
  | "REPLACED";

export type OutcomeVerification = "PENDING_WINDOW" | "VERIFIED" | "CONTRADICTED" | "TIMEOUT";

export type PaymentState =
  | "NONE"
  | "CHALLENGED"
  | "PROOF_RECEIVED"
  | "VERIFIED"
  | "SETTLE_SUBMITTED"
  | "SETTLED"
  | "CONFIRMED"
  | "RECONCILED"
  | "VERIFY_FAILED"
  | "SETTLE_FAILED"
  | "EXPIRED_UNSETTLED"
  | "UNKNOWN";

export type PreparationMode =
  | "HARD_HOLD"
  | "SOFT_HOLD"
  | "REVALIDATED"
  | "INSTANT_COMMIT_ONLY"
  | "UNSUPPORTED"
  | "BONDED_QUOTE";

export type LegClass = "SUPPLIER_SANDBOX" | "SIMULATED" | "CALLER_SUPPLIED" | "X402_MERCHANT";

export type EvidenceGrade = "SIMULATED" | "SUPPLIER_SANDBOX" | "CALLER_ASSERTED" | "SUPPLIER_PRODUCTION" | "SUPPLIER_SIGNED";

export type EvidenceTier = "E0" | "E1" | "E2";

export type ComponentType = "FLIGHT" | "HOTEL" | "GROUND" | "TRANSFER" | "RAIL" | "EVENT" | "ESIM" | "OTHER";

export type RefundDestination = "CASH" | "CREDIT" | "NONE" | "UNKNOWN";

export type ProofState =
  | "PROOF_VERIFIED"
  | "PROOF_PARTIAL"
  | "SIGNATURE_INVALID"
  | "HASH_MISMATCH"
  | "ANCHOR_NOT_FOUND"
  | "ANCHOR_UNCONFIRMED"
  | "MANIFEST_SUPERSEDED"
  | "INDEXER_UNAVAILABLE";

export interface Money {
  amount_minor: number;
  currency: string;
}

export interface NextAction {
  action: string;
  allowed: boolean;
  reason?: string;
  deadline?: string;
}

export interface GateDecision {
  decision_id: string;
  gate: Gate | string;
  outcome: DecisionOutcome;
  reason_codes?: string[];
  subject?: Record<string, string | undefined>;
  decided_at?: string;
  decided_by?: { actor_type: string; actor_id?: string };
  reconcile_by?: string;
  required_role?: string;
  decision_hash?: string;
}

export interface ComponentClocks {
  price_valid_until?: string | null;
  inventory_held_until?: string | null;
  free_cancel_until?: string | null;
  void_until?: string | null;
  refund_destination?: RefundDestination;
  refund_amount_certainty?: "QUOTED" | "ESTIMATED" | "UNKNOWN";
  confirmation_mode?: "INSTANT" | "ASYNC" | "MANUAL";
  supplier_can_cancel?: boolean;
}

export interface TripComponent extends ComponentClocks {
  component_id: string;
  type: ComponentType | string;
  state: ComponentState;
  preparation_mode?: PreparationMode;
  evidence_grade?: EvidenceGrade;
  leg_class?: LegClass;
  adapter?: string;
  supplier?: string;
  label?: string;
  description?: string;
  price?: Money;
  commit_order?: number;
  irreversible?: boolean;
  outcome_verification?: OutcomeVerification;
  supplier_reference?: string;
  evidence_tier?: EvidenceTier;
  readiness_score?: number;
  warnings?: string[];
  /** Supplier-authored text. Rendered as plain text only. */
  untrusted_notes?: string[];
  decisions?: GateDecision[];
  replaced_by?: string;
  replaces?: string;
}

export interface AnchorRef {
  network?: string;
  txid?: string;
  round?: number;
  app_id?: number;
  mode?: string;
  confirmed?: boolean;
}

export interface Trip {
  trip_id: string;
  state: TripState;
  environment?: Environment;
  created_at?: string;
  updated_at?: string;
  label?: string;
  total?: Money;
  maximum_total?: Money;
  components: TripComponent[];
  manifest_id?: string;
  manifest_hash?: string;
  manifest_status?: ManifestStatus;
  manifest_expires_at?: string;
  readiness_score?: number;
  decisions?: GateDecision[];
  non_actions?: GateDecision[];
  next_actions?: NextAction[];
  payment_state?: PaymentState;
  payment_txid?: string;
  operation_id?: string;
  assurance?: { mode: "NONE" | string };
  financial_closure?: "NONE" | "OPEN" | "CLOSED";
  approval?: {
    required: boolean;
    status?: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "STALE";
    reason_codes?: string[];
    manifest_hash?: string;
    expires_at?: string;
  };
  anchors?: AnchorRef[];
  run_label?: string;
  scenario_seed?: string | number;
}

export interface TripSummary {
  trip_id: string;
  state: TripState;
  created_at: string;
  label?: string;
  total?: Money;
  components: Array<Pick<TripComponent, "component_id" | "type" | "state" | "preparation_mode" | "evidence_grade">>;
  next_action?: NextAction;
}

export interface OperationStep {
  step: string;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "UNKNOWN" | "SKIPPED";
  component_id?: string;
  at?: string;
  detail?: string;
}

export interface Operation {
  operation_id: string;
  kind?: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | string;
  trip_id?: string;
  started_at?: string;
  updated_at?: string;
  steps?: OperationStep[];
  payment_state?: PaymentState;
  payment_txid?: string;
  decision?: GateDecision;
  next_actions?: NextAction[];
  supplier_action_may_have_occurred?: boolean;
}

export interface ManifestSignature {
  alg: "Ed25519";
  key_id: string;
  context: string;
  value: string;
}

export interface ManifestDocument {
  manifest_id: string;
  kind?: "CommitPlan" | "CommitManifest" | "TransactionManifest" | string;
  environment?: Environment;
  manifest_hash?: string;
  payload?: Record<string, unknown>;
  signature?: ManifestSignature;
  status?: ManifestStatus;
  status_record?: Record<string, unknown>;
  anchors?: AnchorRef[];
  supersedes?: string | null;
  superseded_by?: string | null;
  created_at?: string;
}

export interface VerifyCheck {
  check: string;
  status: "PASS" | "FAIL" | "PENDING" | "SKIPPED";
  detail?: string;
}

export interface VerifyResult {
  proof_state: ProofState;
  manifest_id?: string;
  manifest_hash?: string;
  environment?: Environment;
  checks: VerifyCheck[];
  anchors?: AnchorRef[];
  evidence_grades?: EvidenceGrade[];
  indexer?: string;
  verified_at?: string;
}

export interface PriceRoute {
  method: string;
  path: string;
  name: string;
  price_usdc: string;
  price_atomic?: string;
  unique_output?: string;
  fee_disposition?: string;
  requires_chain_confirmation?: boolean;
}

export interface PriceTable {
  environment: Environment;
  network: string;
  asset: string;
  pay_to?: string;
  tag?: string;
  note?: string;
  routes: PriceRoute[];
}

export interface PublicStats {
  paid_calls?: number;
  usdc_settled?: string;
  external_payers?: number;
  repeat_payers?: number;
  as_of?: string;
}

export interface EvidenceRun {
  run_id: string;
  label?: string;
  environment?: Environment;
  created_at?: string;
  status?: string;
  trip_id?: string;
  manifest_id?: string;
  scenario?: string;
  supplier_mode?: string;
  payments?: Array<{ txid: string; amount?: string; network?: string; payer_class?: string }>;
  anchors?: AnchorRef[];
  events?: Array<{ at: string; type: string; detail?: string; hash?: string }>;
  limitations?: string[];
}

export interface SandboxSession {
  session_id: string;
  expires_at: string;
}

export interface DemoRun {
  run_id: string;
  trip_id: string;
  operation_id: string;
}

export interface VersionInfo {
  version?: string;
  commit?: string;
  api?: string;
  schema?: string;
  networks?: Record<string, unknown>;
}

/** Legs an agent brings itself (POST .../trips/check). */
export interface CallerLeg {
  type: ComponentType;
  supplier: string;
  offer_id?: string;
  price: Money;
  expires_at?: string;
  hold_type?: PreparationMode;
  refundable?: boolean;
  free_cancel_until?: string;
  requires_instant_payment?: boolean;
}

export interface TripRequest {
  label?: string;
  components: Array<{
    type: ComponentType;
    origin?: string;
    destination?: string;
    location?: string;
    depart_on?: string;
    check_in?: string;
    check_out?: string;
    pickup_at?: string;
    travelers?: number;
    source?: "SUPPLIER_SANDBOX" | "SIMULATED";
    scenario?: string;
  }>;
  budget_total: Money;
  max_price_move_pct?: number;
  min_readiness?: number;
}
