import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runB0 } from "./arms/b0-naive";
import { runB1 } from "./arms/b1-competent";
import { CELLS, SHAPES, tripFor } from "./cells";
import { runInProcess, type RunRecord } from "./harness";
import { markdownTable, summarize } from "./metrics";
import type { Arm } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const ARMS: Record<string, { arm: Arm; file: string }> = {
  B0: { arm: runB0, file: join(here, "arms/b0-naive.ts") },
  B1: { arm: runB1, file: join(here, "arms/b1-competent.ts") },
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: here }).toString().trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arms: { type: "string", default: "B0,B1" },
      repeats: { type: "string", default: "5" },
      campaign: { type: "string", default: "campaign-001" },
      out: { type: "string" },
    },
  });
  const arms = values.arms.split(",").map((a) => a.trim()).filter(Boolean);
  for (const a of arms) if (!ARMS[a]) throw new Error(`unknown in-process arm ${a} (have ${Object.keys(ARMS).join(", ")})`);
  const repeats = Number.parseInt(values.repeats, 10);
  const outDir = resolve(values.out ?? join(here, "../../../evidence", values.campaign));
  mkdirSync(outDir, { recursive: true });

  const records: RunRecord[] = [];
  for (const cell of CELLS) {
    for (const shape of SHAPES) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const trip = tripFor(cell, shape, repeat, values.campaign);
        for (const armName of arms) {
          records.push(
            await runInProcess(ARMS[armName]!.arm, trip, { campaign: values.campaign, cell: cell.id, shape: shape.id, repeat, armName }),
          );
        }
      }
    }
  }

  const { byCell, byArm } = summarize(records, CELLS);
  writeFileSync(join(outDir, "results.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ byArm, byCell }, null, 2) + "\n");
  writeFileSync(
    join(outDir, "run-manifest.json"),
    JSON.stringify(
      {
        campaign: values.campaign,
        environment: "in-process seeded simulator (SIMULATED suppliers)",
        git_sha: gitSha(),
        node: process.version,
        arms: Object.fromEntries(arms.map((a) => [a, { file: ARMS[a]!.file.replace(/^.*packages\//, "packages/"), sha256: sha256File(ARMS[a]!.file) }])),
        cells: CELLS,
        shapes: SHAPES,
        repeats,
        runs: records.length,
        artifacts: { results: "results.jsonl", summary: "summary.json", table: "SUMMARY.md" },
      },
      null,
      2,
    ) + "\n",
  );
  const table = markdownTable(byCell, byArm, CELLS);
  writeFileSync(
    join(outDir, "SUMMARY.md"),
    `# ${values.campaign}\n\nSuppliers in these runs are the seeded simulator (SIMULATED). The auditor reads the simulator's order list, never an arm's own records.\n\n${table}\n`,
  );
  console.log(table);
  console.log(`\n${records.length} runs written to ${outDir}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
