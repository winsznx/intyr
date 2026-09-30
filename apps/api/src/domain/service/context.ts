import type { AdapterRegistry } from "@intyr/adapters";
import type { AnchorRef, Environment, GateDecision, SigningKey } from "@intyr/core";
import type { TripStore } from "../store";

export interface ServiceDeps {
  store: TripStore;
  adapters: AdapterRegistry;
  key: SigningKey;
  environment: Environment;
  /** Seeded fault scenarios are accepted on the TestNet sandbox host only. */
  allowScenario: boolean;
  now: () => Date;
  /** Records a manifest hash on chain. Returns null when anchoring is not configured. */
  anchor?: (manifestHash: string) => Promise<AnchorRef | null>;
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
