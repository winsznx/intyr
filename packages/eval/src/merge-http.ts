import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CELLS } from "./cells";
import type { RunRecord } from "./harness";
import { markdownTable, summarize } from "./metrics";

/**
 * Merges the T shards into one results file and recomputes the campaign table
 * with the in-process arms. Records listed in harness-exclusions.jsonl are left
 * out and reported, never silently dropped.
 */

const here = dirname(fileURLToPath(import.meta.url));

function readJsonl<T>(path: string): T[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}

interface Exclusion {
  cell: string;
  shape: string;
  repeat: number;
  seed: string;
  reason: string;
}

function main(): void {
  const { values } = parseArgs({ options: { campaign: { type: "string", default: "campaign-001" } } });
  const dir = resolve(join(here, "../../../evidence", values.campaign));
  const shardsDir = join(dir, "t-shards");
  const exclusions = readJsonl<Exclusion>(join(dir, "harness-exclusions.jsonl"));
  const excluded = (r: RunRecord): Exclusion | undefined => exclusions.find((e) => e.cell === r.cell && e.shape === r.shape && e.repeat === r.repeat && e.seed === r.seed);

  const tRecords: RunRecord[] = [];
  const dropped: Array<RunRecord & { reason: string }> = [];
  for (const shard of existsSync(shardsDir) ? readdirSync(shardsDir) : []) {
    for (const r of readJsonl<RunRecord>(join(shardsDir, shard, "t-results.jsonl"))) {
      const e = excluded(r);
      if (e) dropped.push({ ...r, reason: e.reason });
      else tRecords.push(r);
    }
  }
  // Keep the latest record per trip slot (a rerun after an exclusion replaces nothing, it fills the slot).
  const slot = (r: RunRecord): string => `${r.cell}|${r.shape}|${r.repeat}`;
  const bySlot = new Map<string, RunRecord>();
  for (const r of tRecords) bySlot.set(slot(r), r);
  const t = [...bySlot.values()];

  const inProcess = readJsonl<RunRecord>(join(dir, "results.jsonl")).filter((r) => r.arm !== "T");
  const { byCell, byArm } = summarize([...inProcess, ...t], CELLS);
  writeFileSync(join(dir, "t-results.jsonl"), t.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ byArm, byCell, t_runs: t.length, t_excluded: dropped.length }, null, 2) + "\n");
  const missing = CELLS.flatMap((c) => ["S1", "S2"].flatMap((s) => [1, 2, 3, 4, 5].map((n) => `${c.id}|${s}|${n}`))).filter((k) => !bySlot.has(k));
  const exclusionNote = dropped.length
    ? `\n\nExcluded T runs (harness faults, not product behaviour): ${dropped.map((d) => `${d.cell} ${d.shape} r${d.repeat} (${d.reason})`).join("; ")}.`
    : "";
  const missingNote = missing.length ? `\n\nT runs not yet recorded: ${missing.length} (${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", ..." : ""}).` : "";
  writeFileSync(
    join(dir, "SUMMARY.md"),
    `# ${values.campaign}\n\nSuppliers in these runs are the seeded simulator (SIMULATED). B0 and B1 ran in process. T ran against the deployed Worker's sandbox routes under server-sponsored TestNet sessions, so no USDC moved. The auditor reads the simulator's order list, never an arm's own records.${exclusionNote}${missingNote}\n\n${markdownTable(byCell, byArm, CELLS)}\n`,
  );
  console.log(markdownTable(byCell, byArm, CELLS));
  console.log(`\nT runs: ${t.length}, excluded: ${dropped.length}, missing: ${missing.length}`);
}

main();
