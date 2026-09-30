import { describe, expect, it } from "vitest";
import { createTestD1 } from "./support/d1";
import { TripStore, VersionConflictError } from "../src/domain/store";

const now = () => new Date().toISOString();

describe("TripStore", () => {
  it("lets exactly one supplier commit attempt exist per component", async () => {
    const s = new TripStore(createTestD1());
    const a = await s.startAttempt({ trip_id: "trp_1", component_id: "c1", action: "COMMIT", request_hash: "sha256:a", idempotency_ref: "ref1", now: now() });
    expect(a.created).toBe(true);
    const b = await s.startAttempt({ trip_id: "trp_1", component_id: "c1", action: "COMMIT", request_hash: "sha256:a", idempotency_ref: "ref1", now: now() });
    expect(b.created).toBe(false);
    expect(b.attempt.id).toBe(a.attempt.id);
    expect(b.attempt.state).toBe("STARTED");
  });

  it("numbers cancel attempts so a cancel can be retried after reconciliation", async () => {
    const s = new TripStore(createTestD1());
    const a = await s.startAttempt({ trip_id: "trp_1", component_id: "c1", action: "CANCEL", request_hash: "x", idempotency_ref: "r", now: now() });
    const b = await s.startAttempt({ trip_id: "trp_1", component_id: "c1", action: "CANCEL", request_hash: "x", idempotency_ref: "r", now: now() });
    expect(a.attempt.attempt_no).toBe(1);
    expect(b.attempt.attempt_no).toBe(2);
  });

  it("advances an attempt only from the expected state", async () => {
    const s = new TripStore(createTestD1());
    const { attempt } = await s.startAttempt({ trip_id: "t", component_id: "c", action: "COMMIT", request_hash: "h", idempotency_ref: "r", now: now() });
    expect(await s.advanceAttempt(attempt.id, ["STARTED"], "RESPONDED", { response_hash: "sha256:r" }, now())).toBe(true);
    expect(await s.advanceAttempt(attempt.id, ["STARTED"], "CONFIRMED", {}, now())).toBe(false);
    expect(await s.advanceAttempt(attempt.id, ["RESPONDED"], "CONFIRMED", {}, now())).toBe(true);
  });

  it("rejects a stale trip write with a version conflict", async () => {
    const s = new TripStore(createTestD1());
    const trip = await s.createTrip({ network: "testnet", owner: "session:x", state: "PREPARING", doc: { a: 1 }, now: now() });
    await s.updateTrip(trip.id, 1, { state: "PREPARED" }, now());
    await expect(s.updateTrip(trip.id, 1, { state: "COMMITTING" }, now())).rejects.toBeInstanceOf(VersionConflictError);
    expect((await s.getTrip(trip.id))?.state).toBe("PREPARED");
  });

  it("returns only the active commit manifest", async () => {
    const s = new TripStore(createTestD1());
    await s.putManifest({ id: "man_1", trip_id: "trp_1", kind: "COMMIT", hash: "sha256:1", status: "ACTIVE", expires_at: null, network: "testnet", signed_json: "{}", now: now() });
    await s.setManifestStatus("man_1", "SUPERSEDED", now());
    await s.putManifest({ id: "man_2", trip_id: "trp_1", kind: "COMMIT", hash: "sha256:2", status: "ACTIVE", expires_at: null, network: "testnet", signed_json: "{}", now: new Date(Date.now() + 1000).toISOString() });
    expect((await s.getActiveManifest("trp_1"))?.id).toBe("man_2");
  });
});

import { D1SimulatorStore } from "../src/domain/adapters";

describe("D1SimulatorStore", () => {
  it("round-trips and overwrites values", async () => {
    const s = new D1SimulatorStore(createTestD1());
    expect(await s.get("k")).toBeNull();
    await s.put("k", "1");
    await s.put("k", "2");
    expect(await s.get("k")).toBe("2");
  });
});

describe("text primary keys", () => {
  it("refuses a NULL key, which SQLite would otherwise accept in a TEXT PRIMARY KEY", async () => {
    const db = createTestD1();
    await expect(db.prepare("INSERT INTO sim_kv (k, v, updated_at) VALUES (NULL, 'v', 't')").run()).rejects.toThrow(/sim_kv\.k must not be null/);
    await db.prepare("INSERT INTO sim_kv (k, v, updated_at) VALUES ('a', 'v', 't')").run();
    await expect(db.prepare("UPDATE sim_kv SET k = NULL WHERE k = 'a'").run()).rejects.toThrow(/sim_kv\.k must not be null/);
  });

  it("guards every TEXT primary key in the schema, so a table added later without a guard fails here", async () => {
    const db = createTestD1();
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>()).results ?? [];
    const unguarded: string[] = [];
    let checked = 0;
    for (const { name } of tables) {
      const keys = (await db.prepare(`SELECT name, type, "notnull" AS required FROM pragma_table_info('${name}') WHERE pk > 0`).all<{ name: string; type: string; required: number }>()).results ?? [];
      for (const key of keys.filter((k) => k.type.toUpperCase() === "TEXT" && k.required === 0)) {
        checked++;
        const guard = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1 AND name LIKE '%not_null_insert'").bind(name).first<{ n: number }>();
        if (!guard?.n) unguarded.push(`${name}.${key.name}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(12);
    expect(unguarded).toEqual([]);
  });
});
