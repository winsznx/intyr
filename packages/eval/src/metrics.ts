import type { FaultCell } from "./cells";
import type { RunRecord } from "./harness";

export interface CellMetrics {
  arm: string;
  cell: string;
  n: number;
  complete: number;
  unwound: number;
  inconsistent: number;
  /** Consistent terminal rate: share of runs ending COMPLETE or UNWOUND. */
  ctr: number;
  /** Value left in live supplier orders of inconsistent trips, USD per 100 trips. */
  orphan_usd_per_100: number;
  duplicate_orders: number;
  belief_mismatches: number;
  belief_unknowns: number;
  completion_rate: number;
  mean_supplier_calls: number;
}

export interface ArmSummary extends CellMetrics {
  /** COMPLETE share over cells where a correct agent can finish the trip. Guards against an arm that always refuses. */
  completion_when_feasible: number;
}

function metrics(arm: string, cell: string, runs: RunRecord[]): CellMetrics {
  const n = runs.length;
  const count = (o: string): number => runs.filter((r) => r.audit.outcome === o).length;
  const complete = count("COMPLETE");
  const unwound = count("UNWOUND");
  const orphanMinor = runs.reduce((s, r) => s + r.audit.orphan_value_minor, 0);
  const calls = runs.reduce((s, r) => s + Object.values(r.supplier_calls).reduce((a, b) => a + b, 0), 0);
  return {
    arm,
    cell,
    n,
    complete,
    unwound,
    inconsistent: n - complete - unwound,
    ctr: n ? (complete + unwound) / n : 0,
    orphan_usd_per_100: n ? (orphanMinor / 100 / n) * 100 : 0,
    duplicate_orders: runs.reduce((s, r) => s + r.audit.duplicate_orders, 0),
    belief_mismatches: runs.reduce((s, r) => s + r.audit.belief_mismatches, 0),
    belief_unknowns: runs.reduce((s, r) => s + r.audit.belief_unknowns, 0),
    completion_rate: n ? complete / n : 0,
    mean_supplier_calls: n ? calls / n : 0,
  };
}

export function summarize(records: RunRecord[], cells: FaultCell[]): { byCell: CellMetrics[]; byArm: ArmSummary[] } {
  const arms = [...new Set(records.map((r) => r.arm))];
  const byCell: CellMetrics[] = [];
  for (const arm of arms) {
    for (const cell of cells) {
      const runs = records.filter((r) => r.arm === arm && r.cell === cell.id);
      if (runs.length) byCell.push(metrics(arm, cell.id, runs));
    }
  }
  const feasible = new Set(cells.filter((c) => c.feasible).map((c) => c.id));
  const byArm: ArmSummary[] = arms.map((arm) => {
    const runs = records.filter((r) => r.arm === arm);
    const feasibleRuns = runs.filter((r) => feasible.has(r.cell));
    return {
      ...metrics(arm, "ALL", runs),
      completion_when_feasible: feasibleRuns.length ? feasibleRuns.filter((r) => r.audit.outcome === "COMPLETE").length / feasibleRuns.length : 0,
    };
  });
  return { byCell, byArm };
}

/**
 * Exact two-sided sign test over paired cells. `wins` and `losses` exclude ties.
 * Returns the probability of a split at least this lopsided under no difference.
 */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export function markdownTable(byCell: CellMetrics[], byArm: ArmSummary[], cells: FaultCell[]): string {
  const title = new Map(cells.map((c) => [c.id, c.title]));
  const lines = [
    "| Arm | Cell | Runs | Complete | Unwound | Inconsistent | CTR | Orphan USD / 100 trips | Duplicate orders | Belief mismatches |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...byCell.map(
      (m) =>
        `| ${m.arm} | ${m.cell} ${title.get(m.cell) ?? ""} | ${m.n} | ${m.complete} | ${m.unwound} | ${m.inconsistent} | ${pct(m.ctr)} | ${m.orphan_usd_per_100.toFixed(2)} | ${m.duplicate_orders} | ${m.belief_mismatches} |`,
    ),
    "",
    "| Arm | Runs | CTR | Completion when feasible | Orphan USD / 100 trips | Duplicate orders | Belief mismatches | Unknown beliefs | Mean supplier calls |",
    "|---|---|---|---|---|---|---|---|---|",
    ...byArm.map(
      (m) =>
        `| ${m.arm} | ${m.n} | ${pct(m.ctr)} | ${pct(m.completion_when_feasible)} | ${m.orphan_usd_per_100.toFixed(2)} | ${m.duplicate_orders} | ${m.belief_mismatches} | ${m.belief_unknowns} | ${m.mean_supplier_calls.toFixed(1)} |`,
    ),
  ];
  return lines.join("\n");
}
