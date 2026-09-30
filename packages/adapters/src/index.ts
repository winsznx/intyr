import { CallerSuppliedAdapter } from "./caller-supplied";
import type { AdapterClock, AdapterId, ComponentType, FetchLike, IntyrAdapter } from "./contract";
import { DuffelFlightsAdapter } from "./duffel";
import { LiteApiHotelsAdapter } from "./liteapi";
import { SimulatorAdapter, type SimulatorStore } from "./simulator";

export * from "./contract";
export { CallerSuppliedAdapter, CallerSuppliedLegError, callerPreparationMode, legFromCallerSupplied, validateCallerLeg } from "./caller-supplied";
export { DuffelFlightsAdapter, type DuffelOptions } from "./duffel";
export { LiteApiHotelsAdapter, type LiteApiOptions } from "./liteapi";
export { MemorySimulatorStore, SimulatorAdapter, type SimOrder, type SimOrderStatus, type SimulatorOptions, type SimulatorStore } from "./simulator";
export { toDecimal, toMoney } from "./util";

export interface AdapterEnv {
  DUFFEL_TOKEN?: string;
  LITEAPI_KEY?: string;
}

export interface AdapterDeps {
  simulatorStore: SimulatorStore;
  fetch?: FetchLike;
  clock?: AdapterClock;
  simulatorLagSeconds?: number;
}

export interface AdapterRegistry {
  get(id: AdapterId): IntyrAdapter | undefined;
  all(): IntyrAdapter[];
  /** First configured adapter for a component type, preferring supplier sandboxes over the simulator. */
  forType(type: ComponentType, options?: { simulated?: boolean }): IntyrAdapter | undefined;
}

/**
 * Builds every R0 adapter from Worker bindings. Adapters whose credentials are
 * missing are still returned, report `configured: false` and refuse all calls.
 * x402-merchant legs are handled by apps/api because they spend USDC.
 */
export function createAdapters(env: AdapterEnv, deps: AdapterDeps): AdapterRegistry {
  const adapters: IntyrAdapter[] = [
    new DuffelFlightsAdapter({ token: env.DUFFEL_TOKEN, fetch: deps.fetch, clock: deps.clock }),
    new LiteApiHotelsAdapter({ apiKey: env.LITEAPI_KEY, fetch: deps.fetch, clock: deps.clock }),
    new SimulatorAdapter({ adapterId: "sim-ground", store: deps.simulatorStore, clock: deps.clock, visibilityLagSeconds: deps.simulatorLagSeconds }),
    new SimulatorAdapter({ adapterId: "sim-hostile", store: deps.simulatorStore, clock: deps.clock, visibilityLagSeconds: deps.simulatorLagSeconds }),
    new CallerSuppliedAdapter(deps.clock),
  ];
  const byId = new Map(adapters.map((a) => [a.metadata().adapter_id, a] as const));
  return {
    get: (id) => byId.get(id),
    all: () => adapters,
    forType(type, options = {}) {
      if (options.simulated) return type === "GROUND" ? byId.get("sim-ground") : byId.get("sim-hostile");
      const supplier = adapters.find((a) => {
        const m = a.metadata();
        return m.leg_class === "SUPPLIER_SANDBOX" && m.configured && m.component_types.includes(type);
      });
      return supplier ?? (type === "GROUND" ? byId.get("sim-ground") : byId.get("sim-hostile"));
    },
  };
}
