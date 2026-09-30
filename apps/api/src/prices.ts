/** USDC has six decimals. Prices are assumptions to be revisited against measured usage, see docs/PRICING.md. */
export interface RoutePrice {
  key: string;
  path: string;
  name: string;
  description: string;
  amountAtomic: string;
  unique_output: string;
  fee_disposition: string;
  requires_chain_confirmation: boolean;
}

export const ROUTE_PRICES: RoutePrice[] = [
  {
    key: "POST /v1/trips/check",
    path: "/v1/trips/check",
    name: "Check a trip before committing",
    description:
      "Send 2 to 6 legs (flight, hotel, transfer). Get a safe commit order, the firmness of each leg, what cannot be undone, a verdict and a signed plan anchored on Algorand.",
    amountAtomic: "100000",
    unique_output: "signed commit plan with commit order, per-leg hold strength, irreversible exposure and verdict",
    fee_disposition: "kept unless Intyr fails to produce a plan, then refunded",
    requires_chain_confirmation: false,
  },
  {
    key: "POST /v1/trips/prepare",
    path: "/v1/trips/prepare",
    name: "Prepare a trip through supplier adapters",
    description:
      "Intyr fetches and revalidates each leg from its supplier, labels the evidence grade, and returns a trip with a signed Commit Manifest. Nothing is booked.",
    amountAtomic: "250000",
    unique_output: "trip and signed commit manifest with supplier clocks and evidence grades",
    fee_disposition: "kept unless Intyr-side failure, then refunded",
    requires_chain_confirmation: false,
  },
  {
    key: "POST /v1/trips/revalidate",
    path: "/v1/trips/revalidate",
    name: "Revalidate a prepared trip",
    description: "Re-check price and availability of a prepared trip. Any material change supersedes the old manifest.",
    amountAtomic: "50000",
    unique_output: "manifest diff and a new or unchanged manifest",
    fee_disposition: "kept unless Intyr-side failure, then refunded",
    requires_chain_confirmation: false,
  },
  {
    key: "POST /v1/trips/commit",
    path: "/v1/trips/commit",
    name: "Commit a prepared trip",
    description:
      "Commit the exact manifest hash under a reconcile-before-retry saga. Irreversible legs go last, unknown outcomes are never retried blindly, and the final record is a signed transaction manifest.",
    amountAtomic: "500000",
    unique_output: "transaction manifest with per-leg confirmations read back from each supplier",
    fee_disposition: "refunded when the gate refuses after settlement or the commit is not executed; kept otherwise",
    requires_chain_confirmation: true,
  },
  {
    key: "POST /v1/trips/recover",
    path: "/v1/trips/recover",
    name: "Recover a partially committed trip",
    description: "Unwind or replace what can be undone inside the limits set before payment and report what cannot.",
    amountAtomic: "250000",
    unique_output: "recovery record with per-leg outcome and realized loss",
    fee_disposition: "kept",
    requires_chain_confirmation: true,
  },
];

export function atomicToUsdc(atomic: string): string {
  const n = BigInt(atomic);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
