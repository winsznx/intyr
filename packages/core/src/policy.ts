import type { Limits } from "./schema";

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
}

export const PUBLIC_DEFAULT_POLICY: Policy = {
  policy_version: "public-default-v1",
  min_readiness: 70,
  max_price_move_pct: 2,
  autonomous_irreversible_cap_minor: 50_000,
  near_expiry_seconds: 120,
};

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
