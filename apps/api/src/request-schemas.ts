import { CheckRequestSchema, CommitRequestSchema, PublicTripIntentSchema, RecoverRequestSchema, RevalidateRequestSchema, jsonSchemaOf } from "@intyr/core";
import type { ZodType } from "zod";

/** Request body schema of each paid route. OpenAPI and the Bazaar discovery extension both publish it, so a client can be generated from either. */
export const REQUEST_SCHEMAS: Record<string, ZodType> = {
  "POST /v1/trips/check": CheckRequestSchema,
  "POST /v1/trips/prepare": PublicTripIntentSchema,
  "POST /v1/trips/revalidate": RevalidateRequestSchema,
  "POST /v1/trips/commit": CommitRequestSchema,
  "POST /v1/trips/recover": RecoverRequestSchema,
};

/** The route's request body as a JSON Schema object, without the dialect marker, which OpenAPI and the Bazaar do not want inside a schema. */
export function requestSchemaOf(routeKey: string): Record<string, unknown> {
  const schema = REQUEST_SCHEMAS[routeKey];
  if (!schema) return { type: "object" };
  const { $schema: _dialect, ...rest } = jsonSchemaOf(schema);
  return rest;
}
