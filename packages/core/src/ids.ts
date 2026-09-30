import { toHex } from "./hash";

export type IdPrefix = "trp" | "leg" | "cmp" | "pln" | "dec" | "man" | "ops" | "pay" | "att" | "run" | "evt" | "sea" | "rfd";

export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${toHex(bytes)}`;
}
