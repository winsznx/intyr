/**
 * Live sandbox probe for the supplier adapters. Runs only against supplier test
 * modes (Duffel test tokens, LiteAPI sandbox keys) and prints what each
 * supplier actually returned, so the adapter mapping can be checked against
 * reality rather than against documentation.
 *
 * Usage: DUFFEL_TOKEN=duffel_test_... LITEAPI_KEY=sand_... pnpm --filter @intyr/adapters smoke
 * Keys can also come from /Users/mac/intyr/.dev.vars (never committed).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DuffelFlightsAdapter, LiteApiHotelsAdapter, SANDBOX_TRAVELER, type IntyrAdapter, type PreparedLeg } from "../src";

function loadDevVars(): void {
  const path = join(import.meta.dirname, "../../../.dev.vars");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  }
}

function days(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

function show(label: string, value: unknown): void {
  console.log(`\n== ${label}\n${JSON.stringify(value, null, 2)}`);
}

async function lifecycle(adapter: IntyrAdapter, leg: PreparedLeg, ref: string): Promise<void> {
  show(`${leg.adapter_id} revalidate`, await adapter.revalidate(leg));
  const commit = await adapter.commit({ leg, operation_id: `smoke_${ref}`, idempotency_ref: ref, max_total: { ...leg.price, amount_minor: leg.price.amount_minor + 1 }, traveler: SANDBOX_TRAVELER });
  show(`${leg.adapter_id} commit`, commit);
  const read = await adapter.postcondition(leg, commit.refs);
  show(`${leg.adapter_id} postcondition`, read);
  if (read.found === "PRESENT") {
    show(`${leg.adapter_id} cancel quote`, await adapter.quoteCancellation(leg, read.refs));
    show(`${leg.adapter_id} cancel`, await adapter.cancel(leg, read.refs));
    show(`${leg.adapter_id} postcondition after cancel`, await adapter.postcondition(leg, read.refs));
  }
}

async function main(): Promise<void> {
  loadDevVars();
  const ref = `smoke_${Date.now()}`;

  const duffel = new DuffelFlightsAdapter({ token: process.env.DUFFEL_TOKEN });
  if (duffel.metadata().configured) {
    // JFK to EWR returns hold-capable offers in Duffel test mode.
    const prep = await duffel.prepare({ component_id: "flight-1", type: "FLIGHT", origin: "JFK", destination: "EWR", depart_date: days(30), adults: 1, currency: "USD" });
    show("duffel prepare", prep.ok ? { ...prep.leg, untrusted_notes: prep.leg.untrusted_notes } : prep);
    if (prep.ok) await lifecycle(duffel, prep.leg, `${ref}_duffel`);
  } else {
    console.log(`duffel skipped: ${duffel.metadata().unconfigured_reason}`);
  }

  const lite = new LiteApiHotelsAdapter({ apiKey: process.env.LITEAPI_KEY });
  if (lite.metadata().configured) {
    const prep = await lite.prepare({ component_id: "hotel-2", type: "HOTEL", check_in: days(30), check_out: days(32), adults: 1, currency: "USD" });
    show("liteapi prepare", prep);
    if (prep.ok) await lifecycle(lite, prep.leg, `${ref}_liteapi`);
  } else {
    console.log(`liteapi skipped: ${lite.metadata().unconfigured_reason}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
