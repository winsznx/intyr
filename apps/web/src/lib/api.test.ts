import { describe, expect, it } from "vitest";
import { PUBLIC, SANDBOX, baseForEnvironment } from "./api";

describe("baseForEnvironment", () => {
  it("sends TestNet records to the sandbox host and MainNet records to /v1", () => {
    expect(baseForEnvironment("TESTNET")).toBe(SANDBOX);
    expect(baseForEnvironment("MAINNET")).toBe(PUBLIC);
  });

  it("leaves the host open when the record names no network", () => {
    expect(baseForEnvironment(undefined)).toBeUndefined();
  });
});
