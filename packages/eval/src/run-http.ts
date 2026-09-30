import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { apiComponentId, IntyrHttpClient, numericSeed, runT, type HttpArmOptions, type HttpSession } from "./arms/t-http";
import { auditTrip } from "./auditor";
import { CELLS, SHAPES, tripFor } from "./cells";
import type { RunRecord } from "./harness";
import { markdownTable, summarize } from "./metrics";
import type { TripSpec } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const TRIPS_PER_SESSION = 15;

/** The same trip with the component ids the API assigns, so the auditor matches simulator orders. */
function apiTrip(trip: TripSpec): TripSpec {
  return { ...trip, components: trip.components.map((c, i) => ({ ...c, component_id: apiComponentId(c.type, i) })) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: process.env.INTYR_BASE_URL ?? "https://intyr.timjosh507.workers.dev" },
      repeats: { type: "string", default: "5" },
      campaign: { type: "string", default: "campaign-001" },
      cells: { type: "string" },
      "min-readiness": { type: "string", default: "30" },
      "max-price-move": { type: "string", default: "10" },
      out: { type: "string" },
      salt: { type: "string", default: "" },
      "worker-version": { type: "string", default: "unknown" },
    },
  });
  const outDir = resolve(values.out ?? join(here, "../../../evidence", values.campaign));
  mkdirSync(outDir, { recursive: true });
  const options: HttpArmOptions = {
    baseUrl: values.base.replace(/\/$/, ""),
    limits: { min_readiness: Number(values["min-readiness"]), max_price_move_pct: Number(values["max-price-move"]) },
  };
  const client = new IntyrHttpClient(options);
  const wanted = values.cells ? new Set(values.cells.split(",")) : null;
  const cells = CELLS.filter((c) => !wanted || wanted.has(c.id));
  const repeats = Number.parseInt(values.repeats, 10);

  // Results are appended per trip so an interrupted run resumes where it stopped.
  const resultsPath = join(outDir, "t-results.jsonl");
  const transcriptsPath = join(outDir, "t-transcripts.jsonl");
  const harnessErrorsPath = join(outDir, "t-harness-errors.jsonl");
  const records: RunRecord[] = existsSync(resultsPath)
    ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunRecord)
    : [];
  const done = new Set(records.map((r) => `${r.cell}|${r.shape}|${r.repeat}`));
  // A trip that hit a harness fault may have left simulator orders behind, so its rerun gets a fresh seed.
  const priorFaults = new Map<string, number>();
  if (existsSync(harnessErrorsPath)) {
    for (const line of readFileSync(harnessErrorsPath, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as { cell: string; shape: string; repeat: number };
      const key = `${e.cell}|${e.shape}|${e.repeat}`;
      priorFaults.set(key, (priorFaults.get(key) ?? 0) + 1);
    }
  }
  let session: HttpSession | null = null;
  let tripsInSession = 0;
  for (const cell of cells) {
    for (const shape of SHAPES) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        if (!session || tripsInSession >= TRIPS_PER_SESSION) {
          session = await client.openSession();
          tripsInSession = 0;
        }
        if (done.has(`${cell.id}|${shape.id}|${repeat}`)) continue;
        tripsInSession += 1;
        const base = tripFor(cell, shape, repeat, values.campaign);
        // The Worker's simulator is shared by every caller; a salt keeps this run's seeds unused.
        const attempt = priorFaults.get(`${cell.id}|${shape.id}|${repeat}`) ?? 0;
        const seed = `${values.salt ? `${values.salt}|` : ""}${base.seed}${attempt ? `#${attempt}` : ""}`;
        const trip = seed === base.seed ? base : { ...base, seed };
        const started = Date.now();
        let outcome: Awaited<ReturnType<typeof runT>>;
        let orders: Awaited<ReturnType<IntyrHttpClient["simOrders"]>>;
        try {
          outcome = await runT(trip, client, session, options);
          // Let asynchronous simulator orders settle before the auditor reads them.
          await new Promise((r) => setTimeout(r, 5000));
          orders = await client.simOrders(numericSeed(trip.seed));
        } catch (err) {
          // A harness fault (network, not the product) is logged and the trip is rerun later with a fresh seed.
          appendFileSync(harnessErrorsPath, JSON.stringify({ cell: cell.id, shape: shape.id, repeat, seed: trip.seed, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() }) + "\n");
          console.log(`${cell.id} ${shape.id} r${repeat}: HARNESS_ERROR ${err instanceof Error ? err.message : String(err)}`);
          session = null;
          continue;
        }
        const { report, trip_id, transcript } = outcome;
        const audited = apiTrip(trip);
        const record: RunRecord = {
          campaign: values.campaign,
          cell: cell.id,
          shape: shape.id,
          repeat,
          arm: "T",
          trip_id: trip.trip_id,
          seed: String(numericSeed(trip.seed)),
          supplier_calls: { http_requests: transcript.length },
          report,
          audit: auditTrip(audited, orders, report),
          simulated_seconds: (Date.now() - started) / 1000,
        };
        records.push(record);
        appendFileSync(resultsPath, JSON.stringify(record) + "\n");
        appendFileSync(transcriptsPath, JSON.stringify({ trip_id: trip.trip_id, intyr_trip_id: trip_id, cell: cell.id, shape: shape.id, repeat, transcript }) + "\n");
        const last = record;
        console.log(`${cell.id} ${shape.id} r${repeat}: ${last.audit.outcome} (${report.verdict}) ${report.notes.at(-1) ?? ""}`);
      }
    }
  }


  const inProcessPath = join(outDir, "results.jsonl");
  const inProcess: RunRecord[] = existsSync(inProcessPath)
    ? readFileSync(inProcessPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunRecord)
    : [];
  const all = [...inProcess, ...records];
  const { byCell, byArm } = summarize(all, CELLS);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ byArm, byCell }, null, 2) + "\n");
  const table = markdownTable(byCell, byArm, CELLS);
  writeFileSync(
    join(outDir, "SUMMARY.md"),
    `# ${values.campaign}\n\nSuppliers in these runs are the seeded simulator (SIMULATED). B0 and B1 ran in process; T ran against the deployed Worker's sandbox routes at ${options.baseUrl} under server-sponsored TestNet sessions, so no USDC moved. The auditor reads the simulator's order list, never an arm's own records. T's declared limits: min_readiness ${options.limits.min_readiness}, max_price_move_pct ${options.limits.max_price_move_pct}.\n\n${table}\n`,
  );
  const manifestPath = join(outDir, "run-manifest.json");
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>) : {};
  manifest.t_arm = {
    base_url: options.baseUrl,
    worker_version: values["worker-version"],
    limits: options.limits,
    arm_file: "packages/eval/src/arms/t-http.ts",
    arm_sha256: createHash("sha256").update(readFileSync(join(here, "arms/t-http.ts"))).digest("hex"),
    git_sha: execSync("git rev-parse HEAD", { cwd: here }).toString().trim(),
    runs: records.length,
    artifacts: { results: "t-results.jsonl", transcripts: "t-transcripts.jsonl" },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(table);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
