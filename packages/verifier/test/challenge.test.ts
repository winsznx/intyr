import type { FetchLike } from "@intyr/chain";
import { describe, expect, it } from "vitest";
import { checkChallenge, checkHostChallenges, ROUTE_SCHEMAS } from "../src/challenge";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAY_TO = "ZBSIVWPNE3WGZBUTLNTGXJBBAAEWYVPHYQL2C2CGYFCLXEL2CWMNYTKTXA";
const HOST = "https://intyr.test";
const VALID_CHECK_BODY = {
  currency: "USD",
  legs: [
    {
      leg_id: "hotel-1",
      type: "HOTEL",
      supplier: "example-hotels",
      offer_ref: "offer-1",
      price: { amount_minor: 40_000, currency: "USD" },
      preparation_mode: "SOFT_HOLD",
      refundable: true,
    },
  ],
};

function header(accept: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
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
    extensions: { bazaar: { info: { input: { type: "http", bodyType: "json", body: VALID_CHECK_BODY } } } },
    ...extra,
  };
  return btoa(JSON.stringify(body));
}

function respond402(value: string): FetchLike {
  return async () => new Response("{}", { status: 402, headers: { "payment-required": value } });
}

const probe = { method: "POST" as const, url: `${HOST}/sandbox/v1/trips/check`, schema: ROUTE_SCHEMAS["check"]! };

describe("checkChallenge", () => {
  it("passes a 402 that a stock client can pay and the facilitator can tag and list", async () => {
    const check = await checkChallenge(probe, { network: "testnet", payTo: PAY_TO }, respond402(header()));
    expect([check.ok, check.problems, check.amount]).toEqual([true, [], "100000"]);
  });

  it("fails a route that validates the body before answering 402", async () => {
    // #given a route that refuses the empty body the x402 Doctor sends
    const refusing: FetchLike = async () => new Response(JSON.stringify({ charged: false }), { status: 422 });

    // #when it is probed
    const check = await checkChallenge(probe, { network: "testnet" }, refusing);

    // #then the listing refresh would fail on it
    expect(check.problems).toEqual(["REFUSES_BEFORE_402"]);
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
    const check = await checkChallenge(probe, { network: "testnet" }, respond402(header({ extra: {} }, { extensions: {} })));
    expect(check.problems).toEqual(["MISSING_CHALLENGE_TAG", "MISSING_FEE_PAYER", "MISSING_BAZAAR_DECLARATION"]);
  });

  it("flags a Bazaar example body that the route's own schema rejects", async () => {
    // #given an example whose price is fractional minor units
    const bad = { ...VALID_CHECK_BODY, legs: [{ ...VALID_CHECK_BODY.legs[0], price: { amount_minor: 10.5, currency: "USD" } }] };
    const value = header({}, { extensions: { bazaar: { info: { input: { body: bad } } } } });

    // #then a client copying the example would be refused
    expect((await checkChallenge(probe, { network: "testnet" }, respond402(value))).problems).toEqual(["BAZAAR_EXAMPLE_INVALID"]);
  });

  it("flags a Mainnet route that points at the TestNet asset", async () => {
    const check = await checkChallenge(
      probe,
      { network: "mainnet" },
      respond402(header({ network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" })),
    );
    expect(check.problems).toEqual(["WRONG_ASSET"]);
  });
});

describe("checkHostChallenges", () => {
  it("requires one payTo across every route in the discovery document", async () => {
    const discovery = {
      resources: [
        { url: `${HOST}/sandbox/v1/trips/check`, method: "POST", network: TESTNET, payTo: PAY_TO },
        { url: `${HOST}/sandbox/v1/trips/prepare`, method: "POST", network: TESTNET, payTo: "OTHERPAYTO" },
      ],
    };
    const fetchFn: FetchLike = async (url) =>
      url.endsWith("/.well-known/x402")
        ? new Response(JSON.stringify(discovery), { status: 200 })
        : new Response("{}", { status: 402, headers: { "payment-required": header() } });
    expect((await checkHostChallenges(HOST, "testnet", fetchFn)).payTo).toBeNull();
  });
});
