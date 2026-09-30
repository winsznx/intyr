import type { PreparedLeg } from "@intyr/adapters";
import type { CallerLeg, ComponentState, ManifestComponent, PaymentRef, PreparationMode, SimulatedFault } from "@intyr/core";
import type { PaymentSession } from "../../payments/sessions";

/** Core component types are wider than the adapter ones; adapters only ever produce FLIGHT, HOTEL or GROUND. */
export function supplierModeOf(leg: PreparedLeg): ManifestComponent["supplier_mode"] {
  if (leg.leg_class === "SIMULATED") return "SIMULATED";
  if (leg.leg_class === "CALLER_SUPPLIED") return "SIMULATED";
  if (leg.supplier_environment === "LIVE") return "LIVE";
  return "SANDBOX";
}

/** Every injected fault is recorded in the manifest so a reader can tell a seeded failure from a real one. */
function syntheticFaultsOf(leg: PreparedLeg): ManifestComponent["synthetic_faults"] {
  if (!leg.sim || leg.sim.scenario === "HAPPY") return [];
  return [{ fault: leg.sim.scenario as SimulatedFault, seed: leg.sim.seed, source: "proxy" }];
}

export function toManifestComponent(leg: PreparedLeg, state: ComponentState): ManifestComponent {
  const c = leg.clocks;
  return {
    component_id: leg.component_id,
    leg_id: leg.component_id,
    type: leg.type,
    leg_class: leg.leg_class,
    adapter_id: leg.adapter_id,
    adapter_version: leg.adapter_version,
    supplier: leg.provider_id,
    preparation_mode: leg.preparation_mode as PreparationMode,
    state,
    price: leg.price,
    clocks: { ...c },
    irreversible: leg.irreversible,
    evidence_grade: leg.evidence_grade,
    supplier_mode: supplierModeOf(leg),
    request_hash: leg.request_hash,
    response_hash: leg.response_hash,
    synthetic_faults: syntheticFaultsOf(leg),
  };
}

/** The planner evaluates caller-shaped legs; a prepared leg is described to it in the same terms. */
export function toPlannerLeg(leg: PreparedLeg): CallerLeg {
  const c = leg.clocks;
  return {
    leg_id: leg.component_id,
    type: leg.type,
    supplier: leg.provider_id,
    offer_ref: leg.refs.offer_id ?? leg.refs.prebook_id ?? leg.component_id,
    price: leg.price,
    preparation_mode: leg.preparation_mode as PreparationMode,
    refundable: !leg.irreversible,
    clocks: { ...c },
    depends_on: [],
    required: true,
  };
}

export function paymentRef(session: PaymentSession): PaymentRef {
  return {
    session_id: session.id,
    route: session.route,
    network: session.network,
    asset_id: Number(session.asset),
    amount_minor: Number(session.amount),
    pay_to: session.pay_to,
    payer: session.payer,
    payer_class: session.payer_class,
    txid: session.txid,
    state: session.state,
    ...(session.confirmed_round !== null ? { confirmed_round: session.confirmed_round } : {}),
  };
}
