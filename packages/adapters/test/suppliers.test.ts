import { describe, expect, it } from "vitest";

import {
  ageOn,
  callerPreparationMode,
  CallerSuppliedLegError,
  DuffelFlightsAdapter,
  legFromCallerSupplied,
  LiteApiHotelsAdapter,
  SANDBOX_TRAVELER,
  type FetchLike,
  type PreparedLeg,
} from "../src";

/**
 * Supplier HTTP is mocked here with response shapes copied from the suppliers'
 * published docs. These tests cover mapping only; they are not evidence that
 * a live sandbox behaves this way.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(routes: Array<[RegExp, number, unknown]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.find(([re]) => re.test(`${init?.method ?? "GET"} ${url}`));
    if (!route) return new Response(JSON.stringify({ errors: [{ code: "not_mocked" }] }), { status: 599 });
    return new Response(JSON.stringify(route[2]), { status: route[1] });
  };
  return { fetch: fetchImpl, calls };
}

const clock = { now: () => new Date("2026-10-01T12:00:00Z") };

const duffelOffer = {
  id: "off_0001",
  total_amount: "245.60",
  total_currency: "USD",
  expires_at: "2026-10-01T12:30:00Z",
  payment_requirements: { requires_instant_payment: true, price_guarantee_expires_at: null, payment_required_by: null },
  conditions: { refund_before_departure: { allowed: false } },
  passengers: [{ id: "pas_1" }],
  owner: { name: "Duffel Airways" },
};

function commitReq(leg: PreparedLeg) {
  return { leg, operation_id: "ops_1", idempotency_ref: "trp_1:cmp_1", max_total: { ...leg.price, amount_minor: leg.price.amount_minor + 100 }, traveler: SANDBOX_TRAVELER };
}

describe("duffel-flights", () => {
  it("searches with the age the traveler has on the travel date", () => {
    expect(ageOn("1990-12-10", "2026-11-01")).toBe(35);
    expect(ageOn("1990-12-10", "2026-12-10")).toBe(36);
  });

  it("refuses to run without a token and refuses live tokens", async () => {
    expect(new DuffelFlightsAdapter({ token: undefined }).metadata().configured).toBe(false);
    const live = new DuffelFlightsAdapter({ token: "duffel_live_x" });
    expect(live.metadata().configured).toBe(false);
    const res = await live.prepare({ component_id: "c", type: "FLIGHT", origin: "LHR", destination: "JFK", depart_date: "2026-11-01", adults: 1, currency: "USD" });
    expect(res.ok).toBe(false);
  });

  it("prepares the cheapest in-budget offer as REVALIDATED by default", async () => {
    const { fetch, calls } = mockFetch([[/POST .*offer_requests/, 201, { data: { offers: [duffelOffer, { ...duffelOffer, id: "off_0002", total_amount: "999.00" }] } }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const res = await adapter.prepare({ component_id: "cmp_1", type: "FLIGHT", origin: "LHR", destination: "JFK", depart_date: "2026-11-01", adults: 1, currency: "USD" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.leg.refs.offer_id).toBe("off_0001");
    expect(res.leg.price).toEqual({ amount_minor: 24560, currency: "USD" });
    expect(res.leg.preparation_mode).toBe("INSTANT_COMMIT_ONLY");
    expect(res.leg.irreversible).toBe(true);
    expect(res.leg.evidence_grade).toBe("SUPPLIER_SANDBOX");
    expect(calls).toHaveLength(1);
  });

  it("maps 201, 202, 200, 503, duplicate_booking and 500 without guessing success", async () => {
    const cases: Array<[number, unknown, string, boolean]> = [
      [201, { data: { id: "ord_1", booking_reference: "ABC123", total_amount: "245.60", total_currency: "USD" } }, "RESPONDED_CONFIRMED", false],
      [202, { data: {} }, "RESPONDED_ACCEPTED", false],
      [200, { data: {} }, "UNKNOWN", false],
      [503, { errors: [{ code: "service_unavailable" }] }, "REJECTED", true],
      [422, { errors: [{ code: "duplicate_booking" }] }, "UNKNOWN", false],
      [422, { errors: [{ code: "offer_no_longer_available" }] }, "REJECTED", true],
      [500, { errors: [{ code: "airline_internal" }] }, "UNKNOWN", false],
    ];
    for (const [status, body, expected, certain] of cases) {
      const { fetch } = mockFetch([
        [/POST .*offer_requests/, 201, { data: { offers: [duffelOffer] } }],
        [/POST .*\/air\/orders$/, status, body],
      ]);
      const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
      const prep = await adapter.prepare({ component_id: "cmp_1", type: "FLIGHT", origin: "LHR", destination: "JFK", depart_date: "2026-11-01", adults: 1, currency: "USD" });
      if (!prep.ok) throw new Error("prepare failed");
      const res = await adapter.commit(commitReq(prep.leg));
      expect([status, res.response]).toEqual([status, expected]);
      expect(res.no_booking_certain).toBe(certain);
    }
  });

  it("puts the Intyr operation id in order metadata and never retries the write", async () => {
    const { fetch, calls } = mockFetch([
      [/POST .*offer_requests/, 201, { data: { offers: [duffelOffer] } }],
      [/POST .*\/air\/orders$/, 500, { errors: [{ code: "airline_internal" }] }],
    ]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const prep = await adapter.prepare({ component_id: "cmp_1", type: "FLIGHT", origin: "LHR", destination: "JFK", depart_date: "2026-11-01", adults: 1, currency: "USD" });
    if (!prep.ok) throw new Error("prepare failed");
    await adapter.commit(commitReq(prep.leg));
    const writes = calls.filter((c) => c.method === "POST" && c.url.endsWith("/air/orders"));
    expect(writes).toHaveLength(1);
    expect((writes[0]!.body as { data: { metadata: Record<string, string> } }).data.metadata.intyr_operation_id).toBe("ops_1");
  });

  it("reconciles by offer id and never treats absence as final", async () => {
    const { fetch } = mockFetch([[/GET .*\/air\/orders\?offer_id=/, 200, { data: [] }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const leg = { refs: { offer_id: "off_0001", hold_order_id: null, prebook_id: null, booking_id: null, booking_reference: null, passenger_ids: [] } } as unknown as PreparedLeg;
    const read = await adapter.reconcileByReference(leg, "x");
    expect(read.found).toBe("UNKNOWN");
    expect(read.absent_is_final).toBe(false);
  });

  it("confirms from an order read with a booking reference and no pending payment", async () => {
    const { fetch } = mockFetch([[/GET .*\/air\/orders\/ord_1/, 200, { data: { id: "ord_1", booking_reference: "ABC123", payment_status: { awaiting_payment: false }, cancelled_at: null, total_amount: "245.60", total_currency: "USD" } }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const leg = { refs: { offer_id: "off_0001" } } as unknown as PreparedLeg;
    const read = await adapter.postcondition(leg, { offer_id: "off_0001", hold_order_id: null, prebook_id: null, booking_id: "ord_1", booking_reference: null, passenger_ids: [] });
    expect(read.found).toBe("PRESENT");
    expect(read.confirmed).toBe(true);
    expect(read.refs.booking_reference).toBe("ABC123");
  });
});

describe("liteapi-hotels", () => {
  const rates = {
    data: [
      {
        hotelId: "lp1897",
        roomTypes: [
          { offerId: "OFF_CHEAP", offerRetailRate: { amount: 180.5, currency: "USD" }, rates: [] },
          { offerId: "OFF_DEAR", offerRetailRate: { amount: 400, currency: "USD" }, rates: [] },
        ],
      },
    ],
  };
  const prebook = {
    data: {
      prebookId: "pre_1",
      currency: "USD",
      price: 180.5,
      roomTypes: [
        {
          rates: [
            {
              cancellationPolicies: {
                refundableTag: "RFN",
                cancelPolicyInfos: [{ cancelTime: "2026-11-01 00:00:00", amount: 180.5, type: "amount", timezone: "GMT", currency: "USD" }],
              },
            },
          ],
        },
      ],
    },
  };

  it("prepares via rates search and prebook, deriving the free-cancel clock", async () => {
    const { fetch, calls } = mockFetch([
      [/POST .*hotels\/rates/, 200, rates],
      [/POST .*rates\/prebook/, 200, prebook],
    ]);
    const adapter = new LiteApiHotelsAdapter({ apiKey: "sand_x", fetch, clock });
    const res = await adapter.prepare({ component_id: "cmp_2", type: "HOTEL", check_in: "2026-11-02", check_out: "2026-11-04", adults: 1, currency: "USD" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.leg.refs.prebook_id).toBe("pre_1");
    expect(res.leg.price).toEqual({ amount_minor: 18050, currency: "USD" });
    expect(res.leg.preparation_mode).toBe("REVALIDATED");
    expect(res.leg.clocks.free_cancel_until).toBe("2026-11-01T00:00:00.000Z");
    expect(res.leg.clocks.price_valid_until).toBe("2026-10-01T12:05:00.000Z");
    expect(res.leg.irreversible).toBe(false);
    expect((calls[1]!.body as { offerId: string }).offerId).toBe("OFF_CHEAP");
  });

  it("resolves the destination to a place and searches that place instead of the default property", async () => {
    const { fetch, calls } = mockFetch([
      [/GET .*data\/places\?textQuery=London/, 200, { data: [{ placeId: "PLACE_LONDON", displayName: "London" }] }],
      [/POST .*hotels\/rates/, 200, rates],
      [/POST .*rates\/prebook/, 200, prebook],
    ]);
    const adapter = new LiteApiHotelsAdapter({ apiKey: "sand_x", fetch, clock });
    const res = await adapter.prepare({ component_id: "cmp_2", type: "HOTEL", destination: "London", check_in: "2026-11-02", check_out: "2026-11-04", adults: 1, currency: "USD" });
    expect(res.ok).toBe(true);
    const search = calls.find((c) => c.url.endsWith("/hotels/rates"))!.body as { placeId?: string; hotelIds?: string[] };
    expect(search.placeId).toBe("PLACE_LONDON");
    expect(search.hotelIds).toBeUndefined();
  });

  it("fails as no offer when the destination matches no place, and lets explicit hotel ids skip the place search", async () => {
    const none = mockFetch([[/GET .*data\/places/, 200, { data: [] }]]);
    const missing = await new LiteApiHotelsAdapter({ apiKey: "sand_x", fetch: none.fetch, clock }).prepare({ component_id: "c", type: "HOTEL", destination: "Nowhereville", check_in: "2026-11-02", check_out: "2026-11-04", adults: 1, currency: "USD" });
    expect(missing).toMatchObject({ ok: false, reason: "NO_OFFER" });

    const explicit = mockFetch([[/POST .*hotels\/rates/, 200, rates], [/POST .*rates\/prebook/, 200, prebook]]);
    await new LiteApiHotelsAdapter({ apiKey: "sand_x", fetch: explicit.fetch, clock }).prepare({ component_id: "c", type: "HOTEL", destination: "London", hotel_ids: ["lp9"], check_in: "2026-11-02", check_out: "2026-11-04", adults: 1, currency: "USD" });
    expect(explicit.calls.some((c) => c.url.includes("data/places"))).toBe(false);
    expect((explicit.calls[0]!.body as { hotelIds: string[] }).hotelIds).toEqual(["lp9"]);
  });

  it("sends clientReference and treats 4005 as a booking that may exist", async () => {
    const { fetch, calls } = mockFetch([
      [/POST .*hotels\/rates/, 200, rates],
      [/POST .*rates\/prebook/, 200, prebook],
      [/POST .*rates\/book/, 400, { error: { code: 4005, message: "duplicate client reference" } }],
    ]);
    const adapter = new LiteApiHotelsAdapter({ apiKey: "sand_x", fetch, clock });
    const prep = await adapter.prepare({ component_id: "cmp_2", type: "HOTEL", check_in: "2026-11-02", check_out: "2026-11-04", adults: 1, currency: "USD" });
    if (!prep.ok) throw new Error("prepare failed");
    const res = await adapter.commit(commitReq(prep.leg));
    expect(res.response).toBe("UNKNOWN");
    expect(res.no_booking_certain).toBe(false);
    const book = calls.find((c) => c.url.endsWith("/rates/book"))!;
    expect((book.body as { clientReference: string }).clientReference).toBe("trp_1:cmp_1");
  });

  it("maps a confirmed booking and a cancellation with charges", async () => {
    const { fetch } = mockFetch([
      [/POST .*hotels\/rates/, 200, rates],
      [/POST .*rates\/prebook/, 200, prebook],
      [/POST .*rates\/book/, 200, { data: { bookingId: "bk_1", status: "CONFIRMED", price: 180.5, currency: "USD" } }],
      [/PUT .*bookings\/bk_1/, 200, { data: { bookingId: "bk_1", status: "CANCELLED_WITH_CHARGES", cancellation_fee: 50, refund_amount: 130.5, currency: "USD" } }],
    ]);
    const adapter = new LiteApiHotelsAdapter({ apiKey: "sand_x", fetch, clock });
    const prep = await adapter.prepare({ component_id: "cmp_2", type: "HOTEL", check_in: "2026-11-02", check_out: "2026-11-04", adults: 1, currency: "USD" });
    if (!prep.ok) throw new Error("prepare failed");
    const res = await adapter.commit(commitReq(prep.leg));
    expect(res.response).toBe("RESPONDED_CONFIRMED");
    expect(res.refs.booking_id).toBe("bk_1");
    const cancel = await adapter.cancel(prep.leg, res.refs);
    expect(cancel.outcome).toBe("CANCELLED_WITH_CHARGES");
    expect(cancel.refund).toEqual({ amount_minor: 13050, currency: "USD" });
    expect(cancel.fee).toEqual({ amount_minor: 5000, currency: "USD" });
  });

  it("maps no availability to a definite rejection", async () => {
    const { fetch } = mockFetch([
      [/POST .*hotels\/rates/, 200, rates],
      [/POST .*rates\/prebook/, 200, prebook],
      [/POST .*rates\/book/, 409, { error: { code: 2001, message: "no availability" } }],
    ]);
    const adapter = new LiteApiHotelsAdapter({ apiKey: "sand_x", fetch, clock });
    const prep = await adapter.prepare({ component_id: "cmp_2", type: "HOTEL", check_in: "2026-11-02", check_out: "2026-11-04", adults: 1, currency: "USD" });
    if (!prep.ok) throw new Error("prepare failed");
    const res = await adapter.commit(commitReq(prep.leg));
    expect(res.response).toBe("REJECTED");
    expect(res.no_booking_certain).toBe(true);
  });
});

describe("caller-supplied legs", () => {
  it("maps hold semantics and marks the evidence as caller asserted", async () => {
    const leg = await legFromCallerSupplied(
      {
        component_id: "cmp_1",
        type: "FLIGHT",
        supplier: "duffel",
        offer_id: "off_1",
        price: { amount_minor: 24560, currency: "USD" },
        requires_instant_payment: false,
        payment_required_by: "2026-10-03T00:00:00Z",
        price_guarantee_expires_at: "2026-10-02T00:00:00Z",
      },
      clock,
    );
    expect(leg.preparation_mode).toBe("HARD_HOLD");
    expect(leg.evidence_grade).toBe("CALLER_ASSERTED");
    expect(leg.clocks.inventory_held_until).toBe("2026-10-03T00:00:00.000Z");
    expect(leg.irreversible).toBe(true);
  });

  it("classifies modes and rejects invalid input", async () => {
    expect(callerPreparationMode({ component_id: "c", type: "HOTEL", supplier: "s", offer_id: "o", price: { amount_minor: 1, currency: "USD" }, requires_instant_payment: true })).toBe("INSTANT_COMMIT_ONLY");
    expect(callerPreparationMode({ component_id: "c", type: "HOTEL", supplier: "s", offer_id: "o", price: { amount_minor: 1, currency: "USD" }, payment_required_by: "2026-10-03T00:00:00Z" })).toBe("SOFT_HOLD");
    await expect(legFromCallerSupplied({ component_id: "c", type: "HOTEL", supplier: "s", offer_id: "o", price: { amount_minor: 1.5, currency: "USD" } })).rejects.toBeInstanceOf(CallerSuppliedLegError);
    await expect(legFromCallerSupplied({ component_id: "c", type: "HOTEL", supplier: "s", offer_id: "o", price: { amount_minor: 1, currency: "usd" } })).rejects.toBeInstanceOf(CallerSuppliedLegError);
  });
});
