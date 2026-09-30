import { describe, expect, it } from "vitest";
import { canonicalize, CanonicalizationError } from "../src/canonical";
import { sha256Hex } from "../src/hash";

describe("canonicalize (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units and strips whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], "é": 2, Z: 3 })).toBe(
      '{"Z":3,"a":[true,null,"x"],"b":1,"é":2}',
    );
  });

  it("uses ECMAScript number serialization", () => {
    expect(canonicalize([1e21, 1e-7, -0, 4.5, 100])).toBe("[1e+21,1e-7,0,4.5,100]");
  });

  it("escapes control characters the JCS way", () => {
    expect(canonicalize("a\u0001\n\"\\")).toBe('"a\\u0001\\n\\"\\\\"');
  });

  it("is independent of insertion order", () => {
    expect(canonicalize({ a: 1, b: { d: 1, c: 2 } })).toBe(canonicalize({ b: { c: 2, d: 1 }, a: 1 }));
  });

  it("rejects undefined, NaN, Infinity and non-plain objects", () => {
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalize(NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Infinity)).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Date())).toThrow(CanonicalizationError);
  });

  it("hashes to a known SHA-256 vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
