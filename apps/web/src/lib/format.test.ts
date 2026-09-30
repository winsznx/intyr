import { describe, expect, it } from "vitest";
import { formatMoney, relativeTime, shortId } from "./format";

describe("formatMoney", () => {
  it("renders minor units with the currency", () => {
    expect(formatMoney({ amount_minor: 54621, currency: "USD" })).toBe("$546.21");
  });

  it("renders USDC with six decimals of precision", () => {
    expect(formatMoney({ amount_minor: 250000, currency: "USDC" })).toBe("0.250 USDC");
  });

  it("says when a price is missing instead of showing zero", () => {
    expect(formatMoney(undefined)).toBe("Not priced");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");

  it("describes future and past times", () => {
    expect(relativeTime("2026-09-30T12:30:00Z", now)).toBe("in 30 min");
    expect(relativeTime("2026-09-30T10:00:00Z", now)).toBe("2 h ago");
  });

  it("returns null for missing or unreadable input", () => {
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime("not a date", now)).toBeNull();
  });
});

describe("shortId", () => {
  it("keeps the start and end of long ids", () => {
    expect(shortId("trp_93112da51ccadc85cff96820", 8, 4)).toBe("trp_9311…6820");
  });
});
