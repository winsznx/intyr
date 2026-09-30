import { describe, expect, it } from "vitest";
import {
  assertTransition,
  ATTEMPT_MACHINE,
  canTransition,
  COMPONENT_MACHINE,
  IllegalTransitionError,
  isTerminal,
  MANIFEST_MACHINE,
  PAYMENT_SESSION_MACHINE,
  reachable,
  REFUND_MACHINE,
  TRIP_MACHINE,
  type Machine,
} from "../src/states";
import {
  ATTEMPT_STATES,
  COMPONENT_STATES,
  MANIFEST_STATUSES,
  PAYMENT_SESSION_STATES,
  REFUND_STATES,
  TRIP_STATES,
} from "../src/vocab";

const TABLES: Array<{ name: string; machine: Machine<string>; vocabulary: readonly string[] }> = [
  { name: TRIP_MACHINE.name, machine: TRIP_MACHINE, vocabulary: TRIP_STATES },
  { name: COMPONENT_MACHINE.name, machine: COMPONENT_MACHINE, vocabulary: COMPONENT_STATES },
  { name: MANIFEST_MACHINE.name, machine: MANIFEST_MACHINE, vocabulary: MANIFEST_STATUSES },
  { name: PAYMENT_SESSION_MACHINE.name, machine: PAYMENT_SESSION_MACHINE, vocabulary: PAYMENT_SESSION_STATES },
  { name: REFUND_MACHINE.name, machine: REFUND_MACHINE, vocabulary: REFUND_STATES },
  { name: ATTEMPT_MACHINE.name, machine: ATTEMPT_MACHINE, vocabulary: ATTEMPT_STATES },
];

function reachesTerminal(machine: Machine<string>, from: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const state = queue.shift()!;
    if (isTerminal(machine, state)) return true;
    for (const next of machine.edges[state] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

describe.each(TABLES)("$name machine", ({ machine, vocabulary }) => {
  it("declares edges for exactly the vocabulary states", () => {
    // #given the canonical vocabulary list
    // #when the machine's edge table keys are read
    // #then they match one to one
    expect(Object.keys(machine.edges).sort()).toEqual([...vocabulary].sort());
  });

  it("only points edges at declared states", () => {
    const targets = Object.values(machine.edges).flat();
    expect(targets.filter((t) => !vocabulary.includes(t))).toEqual([]);
  });

  it("gives terminal states no outgoing edges", () => {
    expect(machine.terminal.filter((s) => machine.edges[s]!.length > 0)).toEqual([]);
  });

  it("reaches every state from the initial state", () => {
    expect([...reachable(machine)].sort()).toEqual([...vocabulary].sort());
  });

  it("lets every state reach a terminal state", () => {
    expect(vocabulary.filter((s) => !reachesTerminal(machine, s))).toEqual([]);
  });
});

describe("transition guards", () => {
  it("throws IllegalTransitionError for an edge that is not in the table", () => {
    // #given a committed trip
    // #when something tries to start committing it again
    // #then the guard fails closed
    expect(() => assertTransition(TRIP_MACHINE, "COMMITTED", "COMMITTING")).toThrow(IllegalTransitionError);
  });

  it("accepts an edge that is in the table", () => {
    expect(() => assertTransition(TRIP_MACHINE, "READY_TO_COMMIT", "COMMITTING")).not.toThrow();
  });

  it("never lets an unknown component be replaced before it is settled", () => {
    // #given a component whose commit outcome is unknown
    // #then it can only settle to CONFIRMED or COMMIT_FAILED, never jump to a replacement or a resubmit
    expect([
      canTransition(COMPONENT_MACHINE, "COMMIT_STATUS_UNKNOWN", "REPLACED"),
      canTransition(COMPONENT_MACHINE, "COMMIT_STATUS_UNKNOWN", "COMMIT_SUBMITTED"),
      canTransition(COMPONENT_MACHINE, "COMMIT_STATUS_UNKNOWN", "RECOVERY_PENDING"),
    ]).toEqual([false, false, false]);
  });

  it("never turns a confirmed booking into a failure", () => {
    expect(canTransition(COMPONENT_MACHINE, "CONFIRMED", "COMMIT_FAILED")).toBe(false);
  });

  it("never moves an unknown payment back to a state that would issue a new challenge", () => {
    expect(canTransition(PAYMENT_SESSION_MACHINE, "UNKNOWN", "CHALLENGED")).toBe(false);
  });
});
