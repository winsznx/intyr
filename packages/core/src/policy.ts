import type { Limits } from "./schema";
import type { Leg } from "./types";
import type { Environment } from "./vocab";

/**
 * Policy the kernel enforces independently of the calling agent. Request
 * limits can only tighten it: every effective value is the stricter of the two.
 */
export interface Policy {
  policy_version: string;
  min_readiness: number;
  max_price_move_pct: number;
  /** Irreversible exposure above this needs a human approval in the sandbox session. */
  autonomous_irreversible_cap_minor: number;
  /** A price or hold that expires sooner than this is treated as stale for commit. */
  near_expiry_seconds: number;
  max_total_minor?: number;
  max_irreversible_minor?: number;
  /** What a readiness below `min_readiness` means: a refusal, or a decision a person must make. Default REFUSE. */
  below_readiness?: "REFUSE" | "REVIEW";
}

export const PUBLIC_DEFAULT_POLICY: Policy = {
  policy_version: "public-default-v1",
  min_readiness: 70,
  max_price_move_pct: 2,
  autonomous_irreversible_cap_minor: 50_000,
  near_expiry_seconds: 120,
};

/**
 * TestNet trips whose required legs all come from a supplier's own sandbox
 * (Duffel test mode, LiteAPI sandbox). Those offers are instant-payment and
 * non-refundable by construction, so they score below the readiness bar. The
 * bar stays where it is, and a low score asks the session approver instead of
 * refusing. The decision records this policy version.
 */
export const SANDBOX_SUPPLIER_POLICY: Policy = {
  ...PUBLIC_DEFAULT_POLICY,
  policy_version: "sandbox-supplier-v1",
  below_readiness: "REVIEW",
};

/** Base policy for a trip. Anything simulated, caller-asserted or on Mainnet keeps the public default. */
export function basePolicyFor(environment: Environment, legs: ReadonlyArray<Pick<Leg, "required" | "evidence_grade">>): Policy {
  const required = legs.filter((l) => l.required);
  const allSandboxSupplier = required.length > 0 && required.every((l) => l.evidence_grade === "SUPPLIER_SANDBOX");
  return environment === "TESTNET" && allSandboxSupplier ? SANDBOX_SUPPLIER_POLICY : PUBLIC_DEFAULT_POLICY;
}

function stricterMax(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

export function effectivePolicy(base: Policy, limits: Limits, budgetTotalMinor?: number): Policy {
  return {
    ...base,
    min_readiness: Math.max(base.min_readiness, limits.min_readiness ?? 0),
    max_price_move_pct: Math.min(base.max_price_move_pct, limits.max_price_move_pct ?? Number.POSITIVE_INFINITY),
    ...(stricterMax(stricterMax(base.max_total_minor, limits.max_total_minor), budgetTotalMinor) !== undefined
      ? { max_total_minor: stricterMax(stricterMax(base.max_total_minor, limits.max_total_minor), budgetTotalMinor) }
      : {}),
    ...(stricterMax(base.max_irreversible_minor, limits.max_irreversible_minor) !== undefined
      ? { max_irreversible_minor: stricterMax(base.max_irreversible_minor, limits.max_irreversible_minor) }
      : {}),
  };
}
