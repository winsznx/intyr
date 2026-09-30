/**
 * RFC 8785 (JCS) canonical JSON. Numbers use the ECMAScript serialization,
 * which is what JCS mandates. Only finite numbers, strings, booleans, null,
 * arrays and plain objects are accepted. `undefined` values are an error so
 * that two producers can never disagree about an omitted field.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function compareUtf16(a: string, b: string): number {
  // JCS sorts property names by UTF-16 code units, which is the default
  // JavaScript string comparison.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError("non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError("only plain objects are canonicalizable");
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(compareUtf16);
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) throw new CanonicalizationError(`undefined value at key "${k}"`);
        parts.push(JSON.stringify(k) + ":" + canonicalize(v));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new CanonicalizationError(`unsupported type ${typeof value}`);
  }
}
