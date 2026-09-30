import {
  createAdapters,
  MemorySimulatorStore,
  SANDBOX_TRAVELER,
  SimulatorAdapter,
  type AdapterClock,
  type IntyrAdapter,
} from "@intyr/adapters";

import { auditTrip, type AuditResult } from "./auditor";
import type { Arm, ArmReport, TripSpec } from "./types";

export class SimulatedClock implements AdapterClock {
  constructor(private t: number) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(seconds: number): void {
    this.t += Math.max(0, seconds) * 1000;
  }
}

export interface RunRecord {
  campaign: string;
  cell: string;
  shape: string;
  repeat: number;
  arm: string;
  trip_id: string;
  seed: string;
  supplier_calls: Record<string, number>;
  report: ArmReport;
  audit: AuditResult;
  simulated_seconds: number;
}

/** Wraps an adapter so every supplier-facing call is counted per method. */
function counting(adapter: IntyrAdapter, counts: Record<string, number>): IntyrAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || prop === "metadata" || prop === "capabilities") return value;
      return (...args: unknown[]) => {
        counts[String(prop)] = (counts[String(prop)] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export interface InProcessOptions {
  campaign: string;
  cell: string;
  shape: string;
  repeat: number;
  armName: string;
  lagSeconds?: number;
  startAt?: string;
}

/**
 * Runs one arm against the seeded simulator in this process. The auditor reads
 * the simulator's order list only after a settle window, so async suppliers
 * have finished and no arm can influence what it sees.
 */
export async function runInProcess(arm: Arm, trip: TripSpec, options: InProcessOptions): Promise<RunRecord> {
  const start = Date.parse(options.startAt ?? "2026-10-01T09:00:00Z");
  const clock = new SimulatedClock(start);
  const store = new MemorySimulatorStore();
  const registry = createAdapters({}, { simulatorStore: store, clock, simulatorLagSeconds: options.lagSeconds ?? 3 });
  const counts: Record<string, number> = {};
  const wrapped = new Map<string, IntyrAdapter>();
  const adapterFor = (type: TripSpec["components"][number]["type"]): IntyrAdapter => {
    const base = registry.forType(type, { simulated: true });
    if (!base) throw new Error(`no simulated adapter for ${type}`);
    const key = base.metadata().adapter_id;
    if (!wrapped.has(key)) wrapped.set(key, counting(base, counts));
    return wrapped.get(key)!;
  };

  let report: ArmReport;
  try {
    report = await arm(trip, {
      adapterFor: (req) => adapterFor(req.type),
      sleep: async (seconds) => clock.advance(seconds),
      now: () => clock.now(),
      traveler: SANDBOX_TRAVELER,
      log: () => undefined,
    });
  } catch (err) {
    report = {
      arm: options.armName,
      trip_id: trip.trip_id,
      verdict: "UNKNOWN",
      components: [],
      notes: [`arm threw: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const simulatedSeconds = (clock.now().getTime() - start) / 1000;
  clock.advance(600);
  const auditorView = new SimulatorAdapter({ adapterId: "sim-hostile", store, clock, visibilityLagSeconds: options.lagSeconds ?? 3 });
  const orders = await auditorView.auditOrders(trip.seed);
  return {
    campaign: options.campaign,
    cell: options.cell,
    shape: options.shape,
    repeat: options.repeat,
    arm: options.armName,
    trip_id: trip.trip_id,
    seed: trip.seed,
    supplier_calls: counts,
    report: { ...report, arm: options.armName },
    audit: auditTrip(trip, orders, { ...report, arm: options.armName }),
    simulated_seconds: simulatedSeconds,
  };
}
