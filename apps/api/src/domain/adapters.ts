import { createAdapters, type AdapterRegistry, type SimulatorStore } from "@intyr/adapters";
import type { Env } from "../env";

/** Backs the deterministic simulator with D1 so its orders survive across Worker invocations. */
export class D1SimulatorStore implements SimulatorStore {
  constructor(private readonly db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT v FROM sim_kv WHERE k = ?1").bind(key).first<{ v: string }>();
    return row?.v ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO sim_kv (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
      .bind(key, value, new Date().toISOString())
      .run();
  }
}

export function createAdapterRegistry(env: Env): AdapterRegistry {
  return createAdapters(
    { DUFFEL_TOKEN: env.DUFFEL_TOKEN, LITEAPI_KEY: env.LITEAPI_KEY },
    { simulatorStore: new D1SimulatorStore(env.DB), fetch: (input, init) => fetch(input, init) },
  );
}
