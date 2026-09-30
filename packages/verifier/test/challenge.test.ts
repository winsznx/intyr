import type { FetchLike } from "@intyr/chain";
import { describe, expect, it } from "vitest";
import { checkChallenge, checkHostChallenges } from "../src/challenge";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAY_TO = "ZBSIVWPNE3WGZBUTLNTGXJBBAAEWYVPHYQL2C2CGYFCLXEL2CWMNYTKTXA";
const HOST = "https://intyr.test";

function header(accept: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const body = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: TESTNET,
        amount: "100000",
        asset: "10458941",
        payTo: PAY_TO,
        extra: { tag: "x402-global-challenge", feePayer: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA" },
        ...accept,
      },
    ],
    extensions: { bazaar: { info: {} } },
    ...extra,
  };
  return btoa(JSON.stringify(body));
}

function respond402(value: string): FetchLike {
  return async () => new Response("{}", { status: 402, headers: { "payment-required": value } });
}

const probe = { method: "POST" as const, url: `${HOST}/sandbox/v1/trips/check`, body: {} };

describe("checkChallenge", () => {
  it("passes a 402 that a stock client can pay and the facilitator can tag", async () => {
    const check = await checkChallenge(probe, { network: "testnet", payTo: PAY_TO }, respond402(header({})));
    expect([check.ok, check.problems, check.amount]).toEqual([true, [], "100000"]);
  });

  it("catches the truncated CAIP-2 id that the @x402/avm constants produce", async () => {
    const check = await checkChallenge(
      probe,
      { network: "testnet" },
      respond402(header({ network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" })),
    );
    expect(check.problems).toEqual(["TRUNCATED_NETWORK_ID"]);
  });

  it("flags a price a stock client refuses without spend controls", async () => {
    const check = await checkChallenge(probe, { network: "testnet" }, respond402(header({ amount: "1500000" })));
    expect(check.problems).toEqual(["PRICE_ABOVE_STOCK_CLIENT_LIMIT"]);
  });

  it("flags a missing challenge tag, fee payer and Bazaar declaration", async () => {
    const check = await checkChallenge(
      probe,
      { network: "testnet" },
      respond402(header({ extra: {} }, { extensions: {} })),
    );
    expect(check.problems).toEqual(["MISSING_CHALLENGE_TAG", "MISSING_FEE_PAYER", "MISSING_BAZAAR_DECLARATION"]);
  });

  it("flags a Mainnet route that points at the TestNet asset", async () => {
    const check = await checkChallenge(
      probe,
      { network: "mainnet" },
      respond402(header({ network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" })),
    );
    expect(check.problems).toEqual(["WRONG_ASSET"]);
  });

  it("passes a trip-bound route that refuses an unknown trip before charging", async () => {
    const refusing: FetchLike = async () =>
      new Response(JSON.stringify({ outcome: "REFUSE", charged: false }), { status: 404 });
    const check = await checkChallenge({ ...probe, expectRefusalBeforeCharge: true }, { network: "testnet" }, refusing);
    expect([check.ok, check.refusedBeforeCharge]).toEqual([true, true]);
  });

  it("fails a trip-bound route that asks to be paid for a trip it has not found", async () => {
    // #given a route that answers 402 even though the probe names no real trip
    const check = await checkChallenge({ ...probe, expectRefusalBeforeCharge: true }, { network: "testnet" }, respond402(header({})));

    // #then it would charge for a request that cannot succeed
    expect(check.problems).toEqual(["CHARGES_BEFORE_TRIP_CHECK"]);
  });

  it("fails a route that answers something other than a 402 to a valid body", async () => {
    const refusing: FetchLike = async () => new Response(JSON.stringify({ charged: false }), { status: 404 });
    expect((await checkChallenge(probe, { network: "testnet" }, refusing)).problems).toEqual(["NOT_402"]);
  });
});

describe("checkHostChallenges", () => {
  it("requires one payTo across every route in the discovery document", async () => {
    // #given a host whose discovery document lists two payTo addresses
    const discovery = {
      resources: [
        { url: `${HOST}/sandbox/v1/trips/check`, method: "POST", network: TESTNET, payTo: PAY_TO },
        { url: `${HOST}/sandbox/v1/trips/prepare`, method: "POST", network: TESTNET, payTo: "OTHERPAYTO" },
      ],
    };
    const fetchFn: FetchLike = async (url) =>
      url.endsWith("/.well-known/x402")
        ? new Response(JSON.stringify(discovery), { status: 200 })
        : new Response("{}", { status: 402, headers: { "payment-required": header({}) } });

    // #when the host is checked
    const result = await checkHostChallenges(HOST, "testnet", { check: {}, prepare: {} }, fetchFn);

    // #then there is no single payTo to hold the routes to
    expect(result.payTo).toBeNull();
  });
});
