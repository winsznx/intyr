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

  it("returns NO_OFFER naming Duffel's currencies when no offer is in the requested currency", async () => {
    const { fetch } = mockFetch([[/POST .*offer_requests/, 201, { data: { offers: [{ ...duffelOffer, total_currency: "EUR" }] } }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const res = await adapter.prepare({ component_id: "cmp_1", type: "FLIGHT", origin: "LHR", destination: "JFK", depart_date: "2026-11-01", adults: 1, currency: "USD" });
    expect(res).toEqual({ ok: false, reason: "NO_OFFER", detail: "Duffel priced every offer in EUR, none in USD", retryable: false });
  });

  it("returns OVER_BUDGET only for an offer in the requested currency above the cap", async () => {
    const { fetch } = mockFetch([[/POST .*offer_requests/, 201, { data: { offers: [duffelOffer] } }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const res = await adapter.prepare({ component_id: "cmp_1", type: "FLIGHT", origin: "LHR", destination: "JFK", depart_date: "2026-11-01", adults: 1, currency: "USD", max_price_minor: 10000 });
    expect(res.ok ? null : res.reason).toBe("OVER_BUDGET");
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

  const unbookedRefs = { offer_id: "off_0001", hold_order_id: null, prebook_id: null, booking_id: null, booking_reference: null, passenger_ids: [] };
  const flightLeg = { refs: unbookedRefs, price: { amount_minor: 24560, currency: "USD" } } as unknown as PreparedLeg;
  const order = (id: string, ref: string | null) => ({
    id,
    booking_reference: `REF${id.slice(-1)}`,
    payment_status: { awaiting_payment: false },
    cancelled_at: null,
    total_amount: "245.60",
    total_currency: "USD",
    metadata: ref ? { intyr_operation_id: "ops_1", intyr_idempotency_ref: ref } : {},
  });

  it("reconciles by offer id and never treats absence as final", async () => {
    const { fetch } = mockFetch([[/GET .*\/air\/orders\?offer_id=/, 200, { data: [] }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const read = await adapter.reconcileByReference(flightLeg, "x");
    expect(read.found).toBe("UNKNOWN");
    expect(read.absent_is_final).toBe(false);
  });

  it("reconciles to the order carrying our reference, not the first order listed for the offer", async () => {
    const { fetch } = mockFetch([[/GET .*\/air\/orders\?offer_id=/, 200, { data: [order("ord_9", "someone-else"), order("ord_1", "intyr-abc")] }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const read = await adapter.reconcileByReference(flightLeg, "intyr-abc");
    expect([read.found, read.confirmed, read.refs.booking_id]).toEqual(["PRESENT", true, "ord_1"]);
  });

  it("stays UNKNOWN and names both orders when two carry our reference", async () => {
    const { fetch } = mockFetch([[/GET .*\/air\/orders\?offer_id=/, 200, { data: [order("ord_1", "intyr-abc"), order("ord_2", "intyr-abc")] }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const read = await adapter.reconcileByReference(flightLeg, "intyr-abc");
    expect([read.found, read.confirmed, read.detail]).toEqual(["UNKNOWN", false, "2 orders match this reference (ord_1, ord_2); not choosing one"]);
  });

  it("does not count an order for the offer that carries another reference", async () => {
    const { fetch } = mockFetch([[/GET .*\/air\/orders\?offer_id=/, 200, { data: [order("ord_9", null)] }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const read = await adapter.reconcileByReference(flightLeg, "intyr-abc");
    expect(read.found).toBe("UNKNOWN");
  });

  it("reads the single order for the offer when a lost response leaves no reference to match", async () => {
    const { fetch } = mockFetch([[/GET .*\/air\/orders\?offer_id=/, 200, { data: [order("ord_1", "intyr-abc")] }]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const read = await adapter.postcondition(flightLeg, unbookedRefs);
    expect([read.found, read.refs.booking_id]).toEqual(["PRESENT", "ord_1"]);
  });

  const bookedRefs = { ...unbookedRefs, booking_id: "ord_1" };
  const cancellation = (refund: string | null, refundTo = "balance", confirmedAt: string | null = null) => ({
    data: { id: "ore_1", order_id: "ord_1", refund_amount: refund, refund_currency: refund === null ? null : "USD", refund_to: refundTo, expires_at: "2026-10-01T13:00:00Z", confirmed_at: confirmedAt },
  });

  it("quotes the cancellation fee as the leg price minus Duffel's refund", async () => {
    const { fetch } = mockFetch([[/POST .*\/air\/order_cancellations$/, 201, cancellation("200.00")]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const quote = await adapter.quoteCancellation(flightLeg, bookedRefs);
    expect([quote.fee, quote.certainty]).toEqual([{ amount_minor: 4560, currency: "USD" }, "QUOTED"]);
  });

  it("leaves the fee unknown when Duffel gives no refund amount", async () => {
    const { fetch } = mockFetch([[/POST .*\/air\/order_cancellations$/, 201, cancellation(null)]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const quote = await adapter.quoteCancellation(flightLeg, bookedRefs);
    expect([quote.fee, quote.certainty]).toEqual([null, "UNKNOWN"]);
  });

  it("charges nothing to cancel a pay-later order that was never paid", async () => {
    const { fetch } = mockFetch([[/POST .*\/air\/order_cancellations$/, 201, cancellation("0.00", "awaiting_payment")]]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const quote = await adapter.quoteCancellation(flightLeg, bookedRefs);
    expect(quote.fee).toEqual({ amount_minor: 0, currency: "USD" });
  });

  it("reports a partial refund as CANCELLED_WITH_CHARGES with the fee", async () => {
    const { fetch } = mockFetch([
      [/POST .*\/air\/order_cancellations$/, 201, cancellation("200.00")],
      [/POST .*\/actions\/confirm/, 200, cancellation("200.00", "balance", "2026-10-01T12:00:05Z")],
    ]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const result = await adapter.cancel(flightLeg, bookedRefs);
    expect([result.outcome, result.fee]).toEqual(["CANCELLED_WITH_CHARGES", { amount_minor: 4560, currency: "USD" }]);
  });

  it("reports a full refund as CANCELLED with a zero fee", async () => {
    const { fetch } = mockFetch([
      [/POST .*\/air\/order_cancellations$/, 201, cancellation("245.60")],
      [/POST .*\/actions\/confirm/, 200, cancellation("245.60", "balance", "2026-10-01T12:00:05Z")],
    ]);
    const adapter = new DuffelFlightsAdapter({ token: "duffel_test_x", fetch, clock });
    const result = await adapter.cancel(flightLeg, bookedRefs);
    expect([result.outcome, result.fee]).toEqual(["CANCELLED", { amount_minor: 0, currency: "USD" }]);
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
