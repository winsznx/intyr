import { afterEach, describe, expect, it, vi } from "vitest";
import { chainFetch, submitSigned, RejectedError } from "../src/algod";
import { networkConfig } from "../src/config";

const PRIMARY = "https://testnet-api.4160.nodely.dev/v2/status";
const SECONDARY = "https://testnet-api.algonode.cloud/v2/status";

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    return handler(url, init);
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("chainFetch", () => {
  it("answers from the primary node and never touches the other domain when it is healthy", async () => {
    const seen = stubFetch(() => new Response("{}", { status: 200 }));
    expect((await chainFetch(PRIMARY)).status).toBe(200);
    expect(seen).toEqual([PRIMARY]);
  });

  it("retries on the other domain after a quota, rate limit, overload or network failure", async () => {
    for (const failure of [403, 429, 503, "throw"] as const) {
      const seen = stubFetch((url) => {
        if (url === PRIMARY) {
          if (failure === "throw") throw new Error("connection reset");
          return new Response("Daily free API quota exceeded", { status: failure });
        }
        return new Response("{}", { status: 200 });
      });
      expect((await chainFetch(PRIMARY)).status).toBe(200);
      expect(seen).toEqual([PRIMARY, SECONDARY]);
    }
  });

  it("does not retry a definitive client error, and gives the first answer back when both domains fail", async () => {
    const one = stubFetch(() => new Response("bad transaction", { status: 400 }));
    expect((await chainFetch(PRIMARY)).status).toBe(400);
    expect(one).toEqual([PRIMARY]);

    stubFetch((url) => new Response(url === PRIMARY ? "quota" : "down", { status: url === PRIMARY ? 403 : 502 }));
    const res = await chainFetch(PRIMARY);
    expect(res.status).toBe(403);
  });

  it("has no alternate for a custom node", async () => {
    const seen = stubFetch(() => new Response("quota", { status: 403 }));
    expect((await chainFetch("https://my-node.example/v2/status")).status).toBe(403);
    expect(seen).toHaveLength(1);
  });
});

describe("submitSigned", () => {
  const net = networkConfig("testnet");
  const respond = (status: number, text: string): typeof fetch => async () => new Response(text, { status });

  it("treats a quota answer as unavailable, not as a rejected transaction", async () => {
    await expect(submitSigned(net, new Uint8Array([1]), respond(403, "Daily free API quota exceeded"))).rejects.toThrow(/unavailable/);
    await expect(submitSigned(net, new Uint8Array([1]), respond(403, "x"))).rejects.not.toBeInstanceOf(RejectedError);
    await expect(submitSigned(net, new Uint8Array([1]), respond(429, "x"))).rejects.not.toBeInstanceOf(RejectedError);
  });

  it("still reports a real rejection, and accepts a transaction a retry finds already in the ledger", async () => {
    await expect(submitSigned(net, new Uint8Array([1]), respond(400, "overspend"))).rejects.toBeInstanceOf(RejectedError);
    await expect(submitSigned(net, new Uint8Array([1]), respond(400, "transaction already in ledger: ABC"))).resolves.toBeUndefined();
  });
});
