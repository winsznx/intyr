import { createAdapters, type AdapterRegistry, type SimulatorStore } from "@intyr/adapters";
import type { Env } from "../env";

/** Backs the deterministic simulator with D1 so its orders survive across Worker invocations. */
export class D1SimulatorStore implements SimulatorStore {
  constructor(private readonly db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT v FROM sim_kv WHERE k = ?1").bind(key).first<{ v: string }>();
    return row?.v ?? null;
  }

  async list(prefix: string): Promise<Array<{ key: string; value: string }>> {
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = await this.db.prepare("SELECT k, v FROM sim_kv WHERE k >= ?1 AND k < ?2 ORDER BY k").bind(prefix, upper).all<{ k: string; v: string }>();
    return (rows.results ?? []).map((r) => ({ key: r.k, value: r.v }));
  }

  async put(key: string, value: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO sim_kv (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
      .bind(key, value, new Date().toISOString())
      .run();
  }
}

/**
 * How long a simulated booking stays invisible after a timed-out commit. A live Worker needs a few seconds between the
 * commit call and the first read, so anything shorter makes a timeout resolve inside the same request and hides the unknown state.
 */
export const SIMULATOR_LAG_SECONDS = 20;

export function createAdapterRegistry(env: Env): AdapterRegistry {
  return createAdapters(
    { DUFFEL_TOKEN: env.DUFFEL_TOKEN, LITEAPI_KEY: env.LITEAPI_KEY },
    { simulatorStore: new D1SimulatorStore(env.DB), simulatorLagSeconds: SIMULATOR_LAG_SECONDS, fetch: (input, init) => fetch(input, init) },
  );
}
