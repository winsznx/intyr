import type { Env } from "../env";
import type { DomainHandlers } from "./index";

/** Wires the domain handlers. Handlers that are not implemented stay absent, so their routes refuse before any charge. */
export function createDomain(_env: Env): DomainHandlers {
  return {};
}
