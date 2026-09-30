import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Minimal D1 shim over node:sqlite so the real SQL runs in tests. Not a mock of behavior: it executes the actual migrations. */
class Statement {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }
  private prep() {
    // D1 uses ?1 style numbered parameters, which SQLite supports natively.
    return this.db.prepare(this.sql);
  }
  async run() {
    const r = this.prep().run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }
  async first<T>() {
    const row = this.prep().get(...(this.params as never[]));
    return (row ?? null) as T | null;
  }
  async all<T>() {
    const rows = this.prep().all(...(this.params as never[]));
    return { success: true, results: rows as T[], meta: {} };
  }
}

export function createTestD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "..", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return {
    prepare: (sql: string) => new Statement(db, sql),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
