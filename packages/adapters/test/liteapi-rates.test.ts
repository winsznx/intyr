import { describe, expect, it } from "vitest";
import { LiteApiHotelsAdapter, type FetchLike } from "../src";

const clock = { now: () => new Date("2026-10-01T12:00:00Z") };

const prebook = {
  data: {
    prebookId: "pre_1",
    price: 100,
    currency: "USD",
    roomTypes: [{ rates: [{ retailRate: { total: [{ amount: 100, currency: "USD" }] }, cancellationPolicies: { refundableTag: "NRFN", cancelPolicyInfos: [] } }] }],
  },
};

const room = (offerId: string, amount: number, tag: string) => ({ offerId, offerRetailRate: { amount, currency: "USD" }, rates: [{ cancellationPolicies: { refundableTag: tag } }] });

async function pickedOffer(rooms: unknown[]): Promise<string> {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/hotels/rates")) return new Response(JSON.stringify({ data: [{ hotelId: "lp1", roomTypes: rooms }] }), { status: 200 });
    if (url.endsWith("/rates/prebook")) return new Response(JSON.stringify(prebook), { status: 200 });
    return new Response("{}", { status: 599 });
  };
  await new LiteApiHotelsAdapter({ apiKey: "sand_x", fetch, clock }).prepare({ component_id: "c", type: "HOTEL", check_in: "2026-11-02", check_out: "2026-11-04", adults: 1, currency: "USD" });
  return (calls.find((c) => c.url.endsWith("/rates/prebook"))!.body as { offerId: string }).offerId;
}

describe("liteapi-hotels rate choice", () => {
  it("prefers a refundable rate over a cheaper non-refundable one", async () => {
    expect(await pickedOffer([room("CHEAP_NRF", 100, "NRFN"), room("DEAR_RFN", 160, "RFN")])).toBe("DEAR_RFN");
  });

  it("takes the cheapest rate when none is refundable", async () => {
    expect(await pickedOffer([room("DEAR_NRF", 160, "NRFN"), room("CHEAP_NRF", 100, "NRFN")])).toBe("CHEAP_NRF");
  });
});
