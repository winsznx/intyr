import { z } from "zod";
import {
  COMPONENT_TYPES,
  CONFIRMATION_MODES,
  PREPARATION_MODES,
  REFUND_CERTAINTIES,
  REFUND_DESTINATIONS,
  SIM_SCENARIOS,
} from "./vocab";

/**
 * Wire formats accepted by the public API. Types are inferred from these
 * validators so the runtime check and the TypeScript type cannot drift, and
 * `jsonSchemaOf` emits the same shapes for OpenAPI and Bazaar discovery.
 */

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const minorUnits = z.number().int().nonnegative().max(1_000_000_000_000);

export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code in upper case");

export const MoneySchema = z.object({
  amount_minor: minorUnits,
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

/**
 * Suppliers expose independent clocks. An unknown clock is null, never
 * absent, so two producers hash the same record the same way.
 */
export const ClocksSchema = z.object({
  price_valid_until: isoDateTime.nullable().default(null),
  inventory_held_until: isoDateTime.nullable().default(null),
  free_cancel_until: isoDateTime.nullable().default(null),
  void_until: isoDateTime.nullable().default(null),
  refund_destination: z.enum(REFUND_DESTINATIONS).default("UNKNOWN"),
  refund_amount_certainty: z.enum(REFUND_CERTAINTIES).default("UNKNOWN"),
  confirmation_mode: z.enum(CONFIRMATION_MODES).default("INSTANT"),
  supplier_can_cancel: z.boolean().default(false),
});
export type Clocks = z.infer<typeof ClocksSchema>;

export const LimitsSchema = z.object({
  max_total_minor: minorUnits.optional(),
  max_irreversible_minor: minorUnits.optional(),
  min_readiness: z.number().int().min(0).max(100).optional(),
  max_price_move_pct: z.number().min(0).max(100).optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

const legId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

/** A leg the caller already found and describes itself (POST /v1/trips/check). */
export const CallerLegSchema = z.object({
  leg_id: legId,
  type: z.enum(COMPONENT_TYPES),
  supplier: z.string().min(1).max(64),
  offer_ref: z.string().min(1).max(256),
  price: MoneySchema,
  preparation_mode: z.enum(PREPARATION_MODES),
  refundable: z.boolean(),
  cancellation_fee_minor: minorUnits.optional(),
  clocks: ClocksSchema.prefault({}),
  depends_on: z.array(legId).max(8).default([]),
  required: z.boolean().default(true),
});
export type CallerLeg = z.infer<typeof CallerLegSchema>;

export const CheckRequestSchema = z.object({
  trip_ref: z.string().max(64).optional(),
  currency: CurrencySchema,
  legs: z.array(CallerLegSchema).min(1).max(8),
  limits: LimitsSchema.default({}),
});
export type CheckRequest = z.infer<typeof CheckRequestSchema>;

const iata = z.string().regex(/^[A-Z]{3}$/, "IATA code");

export const FlightRequestSchema = z.object({
  type: z.literal("FLIGHT"),
  origin: iata,
  destination: iata,
  depart_date: isoDate,
  passengers: z.number().int().min(1).max(9).default(1),
  hold_if_available: z.boolean().default(false),
});

export const HotelRequestSchema = z.object({
  type: z.literal("HOTEL"),
  city: z.string().min(2).max(64).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  check_in: isoDate,
  check_out: isoDate,
  guests: z.number().int().min(1).max(8).default(1),
});

export const GroundRequestSchema = z.object({
  type: z.literal("GROUND"),
  from: z.string().min(2).max(128),
  to: z.string().min(2).max(128),
  pickup_at: isoDateTime,
  passengers: z.number().int().min(1).max(8).default(1),
});

export const MerchantRequestSchema = z.object({
  type: z.enum(["ESIM", "DATA"]),
  merchant_id: z.string().min(1).max(64),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  max_price_minor: minorUnits,
});

export const ComponentRequestSchema = z.discriminatedUnion("type", [
  FlightRequestSchema,
  HotelRequestSchema,
  GroundRequestSchema,
  MerchantRequestSchema.extend({ type: z.literal("ESIM") }),
  MerchantRequestSchema.extend({ type: z.literal("DATA") }),
]);
export type ComponentRequest = z.infer<typeof ComponentRequestSchema>;

/**
 * Seeded failure scenario, accepted only on the TestNet sandbox host. A
 * scenario routes every component through the simulator; the scenario name
 * decides where its fault fires, and HAPPY names a fault-free control leg.
 */
export const ScenarioSchema = z.object({
  seed: z.number().int().nonnegative().max(2 ** 31 - 1),
  faults: z
    .array(
      z.object({
        component_index: z.number().int().min(0).max(4),
        fault: z.enum(SIM_SCENARIOS),
      }),
    )
    .max(5)
    .default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** POST /v1/trips/prepare. No organization, traveler profile or custom header is required. */
export const PublicTripIntentSchema = z.object({
  trip_ref: z.string().max(64).optional(),
  currency: CurrencySchema,
  budget_total_minor: minorUnits,
  components: z.array(ComponentRequestSchema).min(1).max(5),
  limits: LimitsSchema.default({}),
  scenario: ScenarioSchema.optional(),
});
export type PublicTripIntent = z.infer<typeof PublicTripIntentSchema>;

export const TripActionSchema = z.object({
  trip_id: z.string().regex(/^trp_[0-9a-f]{24}$/),
});

export const CommitRequestSchema = TripActionSchema.extend({
  manifest_id: z.string().min(1).max(64),
  manifest_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  maximum_total_minor: minorUnits,
  currency: CurrencySchema,
  recovery_policy_acknowledged: z.literal(true),
});
export type CommitRequest = z.infer<typeof CommitRequestSchema>;

export const RevalidateRequestSchema = TripActionSchema.extend({
  component_ids: z.array(z.string()).max(8).optional(),
});
export type RevalidateRequest = z.infer<typeof RevalidateRequestSchema>;

export const RecoverRequestSchema = TripActionSchema.extend({
  /** Replacement legs are not offered in this release, so the default asks for none. */
  allow_replacement: z.boolean().default(false),
  replacement_headroom_minor: minorUnits.default(0),
});
export type RecoverRequest = z.infer<typeof RecoverRequestSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Array<{ path: string; message: string }> };

/** Validates untrusted input and returns field-level issues instead of throwing. */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): ParseResult<z.infer<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  };
}

/** JSON Schema (draft 2020-12) for OpenAPI and Bazaar discovery input declarations. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}
