export { runB0 } from "./arms/b0-naive";
export { runB1 } from "./arms/b1-competent";
export { auditTrip, type AuditResult, type ComponentTruth, type TripOutcome } from "./auditor";
export { CELLS, SHAPES, tripFor, type FaultCell, type TripShape } from "./cells";
export { runInProcess, SimulatedClock, type InProcessOptions, type RunRecord } from "./harness";
export { markdownTable, signTest, summarize, type ArmSummary, type CellMetrics } from "./metrics";
export type { Arm, ArmDeps, ArmReport, ArmVerdict, BeliefState, ComponentBelief, TripSpec } from "./types";
