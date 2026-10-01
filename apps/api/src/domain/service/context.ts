import type { AdapterRegistry } from "@intyr/adapters";
import type { AnchorRef, Environment, GateDecision, SigningKey } from "@intyr/core";
import type { PaidActor } from "../../payments/ladder";
import type { TripRow, TripStore } from "../store";

export interface ServiceDeps {
  store: TripStore;
  adapters: AdapterRegistry;
  key: SigningKey;
  environment: Environment;
  /** Seeded fault scenarios are accepted on the TestNet sandbox host only. */
  allowScenario: boolean;
  now: () => Date;
  /** Records a manifest hash on chain. Returns null when anchoring is not configured. */
  /** `wait: false` submits the anchor and returns at once, leaving it for the cron to confirm. The final receipt waits. */
  anchor?: (manifestId: string, manifestHash: string, opts?: { wait: boolean }) => Promise<(AnchorRef & { state?: string }) | null>;
}

/**
 * A trip belongs to the network it was prepared on. A trip id from the other host is treated as unknown, so a TestNet
 * sandbox trip can never be committed, recovered or signed as a Mainnet record.
 */
export async function getTripOnNetwork(deps: Pick<ServiceDeps, "store" | "environment">, tripId: string): Promise<TripRow | null> {
  const row = await deps.store.getTrip(tripId);
  return row && row.network === deps.environment.toLowerCase() ? row : null;
}

/** A commit or recovery that touched its trip this recently still has a runner. Older than this, nobody is driving it. */
export const COMMIT_LEASE_MS = 10 * 60_000;

/** What the caller refuses with when a paid action names a trip it does not own. Nothing is charged or run. */
export const NOT_TRIP_OWNER = { status: 403, body: { error: "NOT_TRIP_OWNER", outcome: "REFUSE", reason_codes: ["TRIP_STATE_CONFLICT"], message: "This trip belongs to another payer or sandbox session.", charged: false } } as const;

/**
 * A trip is owned by the payer that prepared it, or by the sandbox session it was prepared in. Holding its ids is not
 * enough to commit, recover or revalidate it, because a published manifest hands those ids to anyone who reads it.
 */
export async function actorOwnsTrip(deps: Pick<ServiceDeps, "store" | "now">, row: Pick<TripRow, "owner">, actor: PaidActor): Promise<boolean> {
  if (actor.payer && row.owner === `payer:${actor.payer}`) return true;
  if (actor.sandboxSessionId && row.owner === `session:${actor.sandboxSessionId}`) {
    const session = await deps.store.getSandboxSession(actor.sandboxSessionId);
    return session !== null && Date.parse(session.expires_at) > deps.now().getTime();
  }
  return false;
}

/** Hash-chained decision log for one trip. Every gate decision is stored before its effect is applied. */
export class DecisionLog {
  private tip: string | undefined;
  private loaded = false;

  constructor(
    private readonly store: TripStore,
    private readonly tripId: string,
    private readonly now: () => Date,
  ) {}

  async prevHash(): Promise<string | undefined> {
    if (!this.loaded) {
      const all = (await this.store.listDecisions(this.tripId)) as GateDecision[];
      this.tip = all.length > 0 ? all[all.length - 1]!.decision_hash : undefined;
      this.loaded = true;
    }
    return this.tip;
  }

  async append(decision: GateDecision): Promise<GateDecision> {
    await this.store.putDecision(this.tripId, decision, this.now().toISOString());
    this.tip = decision.decision_hash;
    this.loaded = true;
    return decision;
  }
}
