import type { ComponentState } from "./vocab";

export interface SagaComponent {
  component_id: string;
  state: ComponentState;
  required: boolean;
}

export type CommitStep =
  | { kind: "SUBMIT"; component_id: string }
  | { kind: "RECONCILE"; component_id: string }
  | { kind: "RECOVER"; failed_component_id: string }
  | { kind: "COMPLETE" }
  | { kind: "HALT"; component_id: string; state: ComponentState };

export class UnknownComponentError extends Error {
  constructor(readonly componentId: string) {
    super(`commit order names ${componentId}, which is not a component of this trip`);
    this.name = "UnknownComponentError";
  }
}

/**
 * Next step of the commit saga. Walks the commit order and stops at the first
 * component that is not settled. An unsettled write is reconciled before
 * anything else moves, so a second leg is never submitted while the first
 * might or might not exist. A failed required component starts recovery;
 * recovery then visits components in reverse commit order.
 */
export function nextCommitStep(order: readonly string[], components: readonly SagaComponent[]): CommitStep {
  const byId = new Map(components.map((c) => [c.component_id, c]));
  for (const id of order) {
    const component = byId.get(id);
    if (!component) throw new UnknownComponentError(id);
    switch (component.state) {
      case "CONFIRMED":
      case "REPLACED":
        continue;
      case "PREPARED":
        return { kind: "SUBMIT", component_id: id };
      case "COMMIT_SUBMITTED":
      case "COMMIT_RESPONDED":
      case "COMMIT_STATUS_UNKNOWN":
        return { kind: "RECONCILE", component_id: id };
      case "COMMIT_FAILED":
      case "UNAVAILABLE":
      case "EXPIRED":
      case "PRICE_UNCERTAIN":
        if (!component.required) continue;
        return { kind: "RECOVER", failed_component_id: id };
      default:
        return { kind: "HALT", component_id: id, state: component.state };
    }
  }
  return { kind: "COMPLETE" };
}
