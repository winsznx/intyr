import {
  buildCommitManifest,
  buildTransactionManifest,
  checkTrip,
  CheckRequestSchema,
  generateSigningKey,
  publishedKey,
  signCommitManifest,
  signDocument,
  signTransactionManifest,
  type ManifestComponent,
  type PaymentRef,
} from "@intyr/core";
import type { FetchLike } from "@intyr/chain";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli";
import { renderReport } from "../src/report";
import { verifyProof } from "../src/verify";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const ENDPOINTS = { [TESTNET]: { algodUrl: "https://algod.test", indexerUrl: "https://indexer.test" } };
const ANCHOR_TXID = "ANCHORTX";
const PAYMENT_TXID = "PAYMENTTX";
const ANCHOR_ACCOUNT = "CIGDS7ZVEG4YDG7YYLL6XMV5TQVEKW4L7FG5ZN7OOH5HZIOK3LFOOS4CZE";
const PAYER = "MH22ASOZRJKSWIXBRWRRTXSVEVLP24IAZ7IVMZMD73VOSY4GHNXAJVH72M";
const PAY_TO = "ZBSIVWPNE3WGZBUTLNTGXJBBAAEWYVPHYQL2C2CGYFCLXEL2CWMNYTKTXA";
const HASH = "sha256:" + "a".repeat(64);

function component(id: string): ManifestComponent {
  return {
    component_id: id,
    leg_id: id,
    type: "HOTEL",
    leg_class: "SIMULATED",
    adapter_id: "sim-hostile",
    adapter_version: "0.1.0",
    supplier: "simulator",
    preparation_mode: "SOFT_HOLD",
    state: "CONFIRMED",
    price: { amount_minor: 20_000, currency: "USD" },
    clocks: {
      price_valid_until: null,
      inventory_held_until: null,
      free_cancel_until: null,
      void_until: null,
      refund_destination: "UNKNOWN",
      refund_amount_certainty: "UNKNOWN",
      confirmation_mode: "INSTANT",
      supplier_can_cancel: false,
    },
    irreversible: false,
    evidence_grade: "SIMULATED",
    supplier_mode: "SIMULATED",
    synthetic_faults: [],
  };
}

const PAYMENT: PaymentRef = {
  session_id: "pay_1",
  route: "POST /sandbox/v1/trips/prepare",
  network: TESTNET,
  asset_id: 10458941,
  amount_minor: 250_000,
  pay_to: PAY_TO,
  payer: PAYER,
  payer_class: "SANDBOX",
  txid: PAYMENT_TXID,
  state: "CONFIRMED",
};

async function signedCommitManifest(inbound: PaymentRef[] = []) {
  const key = await generateSigningKey("intyr-test");
  const manifest = await buildCommitManifest({
    manifest_id: "man_1",
    trip_id: "trp_000000000000000000000001",
    environment: "TESTNET",
    created_at: NOW.toISOString(),
    expires_at: NOW.toISOString(),
    intent_hash: HASH,
    currency: "USD",
    total_minor: 20_000,
    components: [component("cmp_hotel")],
    commit_order: ["cmp_hotel"],
    readiness: { score: 80, validated: false, model_version: "readiness-0.1.0", basis: "PRIOR", minimum_required: 70 },
    exposure: { total_minor: 20_000, irreversible_minor: 0, currency: "USD" },
    decision_log_root: HASH,
    non_actions: [],
    recovery_policy: {
      policy_version: "public-default-v1",
      replacement_headroom_minor: 0,
      cancel_reversible_on_failure: true,
      never_replace_while_unknown: true,
    },
    assurance: { mode: "NONE" },
    inbound_payments: inbound,
  });
  return { key, keys: [publishedKey(key, NOW.toISOString())], signed: await signCommitManifest(key, manifest) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Public-node double: serves an anchor transaction and a USDC transfer, and records every URL it was asked for. */
function chain(opts: { note?: string; sender?: string; transfer?: Partial<{ amount: number; receiver: string }>; indexerDown?: boolean } = {}) {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    if (opts.indexerDown && url.startsWith("https://indexer.test")) return json({}, 503);
    if (url === `https://indexer.test/v2/transactions/${ANCHOR_TXID}`) {
      return json({ transaction: { id: ANCHOR_TXID, "confirmed-round": 900, sender: opts.sender ?? ANCHOR_ACCOUNT, "tx-type": "pay", note: btoa(opts.note ?? "") } });
    }
    if (url === `https://indexer.test/v2/transactions/${PAYMENT_TXID}`) {
      return json({
        transaction: {
          id: PAYMENT_TXID,
          "confirmed-round": 880,
          sender: PAYER,
          "tx-type": "axfer",
          "asset-transfer-transaction": { "asset-id": 10458941, amount: opts.transfer?.amount ?? 250_000, receiver: opts.transfer?.receiver ?? PAY_TO },
        },
      });
    }
    return json({ message: "not found" }, 404);
  };
  return { fetchFn, calls };
}

const noteFor = (payloadHash: string) => `intyr:v1:${payloadHash.slice("sha256:".length)}`;

describe("verifyProof", () => {
  it("verifies a signed manifest whose hash is anchored by the published anchor account", async () => {
    // #given a signed manifest and a public node that holds its anchor note
    const { keys, signed } = await signedCommitManifest();
    const { fetchFn } = chain({ note: noteFor(signed.payload_hash) });

    // #when it is verified from public inputs only
    const report = await verifyProof(
      { signed, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID }, anchorAccounts: { [TESTNET]: ANCHOR_ACCOUNT } },
      { fetch: fetchFn, endpoints: ENDPOINTS },
    );

    // #then every check passes
    expect([report.proof_state, report.anchor.state]).toEqual(["PROOF_VERIFIED", "ANCHOR_CONFIRMED"]);
  });

  it("reports an unanchored but intact manifest as partly verified", async () => {
    const { keys, signed } = await signedCommitManifest();
    const report = await verifyProof({ signed, keys, anchor: null }, { fetch: chain().fetchFn, endpoints: ENDPOINTS });
    expect([report.proof_state, report.anchor.state]).toEqual(["PROOF_PARTIAL", "UNANCHORED"]);
  });

  it("stops at a tampered document without asking the chain anything", async () => {
    // #given a manifest whose total was edited after signing
    const { keys, signed } = await signedCommitManifest();
    const tampered = { ...signed, payload: { ...signed.payload, total_minor: 1 } };
    const { fetchFn, calls } = chain({ note: noteFor(signed.payload_hash) });

    // #when it is verified
    const report = await verifyProof({ signed: tampered, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID } }, { fetch: fetchFn, endpoints: ENDPOINTS });

    // #then it fails on content and no chain read was made
    expect([report.proof_state, report.anchor.state, calls.length]).toEqual(["HASH_MISMATCH", "NOT_CHECKED", 0]);
  });

  it("rejects a manifest signed by a key that is not published", async () => {
    const { signed } = await signedCommitManifest();
    const other = await generateSigningKey("intyr-test");
    const report = await verifyProof({ signed, keys: [publishedKey(other, NOW.toISOString())], anchor: null }, { endpoints: ENDPOINTS });
    expect(report.proof_state).toBe("SIGNATURE_INVALID");
  });

  it("reports an anchor carrying another hash as a hash mismatch", async () => {
    const { keys, signed } = await signedCommitManifest();
    const { fetchFn } = chain({ note: noteFor("sha256:" + "b".repeat(64)) });
    const report = await verifyProof({ signed, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID } }, { fetch: fetchFn, endpoints: ENDPOINTS });
    expect(report.proof_state).toBe("HASH_MISMATCH");
  });

  it("does not accept the right note from an account other than the published anchor account", async () => {
    const { keys, signed } = await signedCommitManifest();
    const { fetchFn } = chain({ note: noteFor(signed.payload_hash), sender: PAYER });
    const report = await verifyProof(
      { signed, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID }, anchorAccounts: { [TESTNET]: ANCHOR_ACCOUNT } },
      { fetch: fetchFn, endpoints: ENDPOINTS },
    );
    expect([report.proof_state, report.anchor.state]).toEqual(["ANCHOR_NOT_FOUND", "ANCHOR_WRONG_SENDER"]);
  });

  it("reports an indexer outage instead of a verdict", async () => {
    const { keys, signed } = await signedCommitManifest();
    const { fetchFn } = chain({ indexerDown: true });
    const report = await verifyProof({ signed, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID } }, { fetch: fetchFn, endpoints: ENDPOINTS });
    expect(report.proof_state).toBe("INDEXER_UNAVAILABLE");
  });

  it("marks a verified but superseded manifest as superseded", async () => {
    const { keys, signed } = await signedCommitManifest();
    const { fetchFn } = chain({ note: noteFor(signed.payload_hash) });
    const report = await verifyProof(
      { signed, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID }, status: "SUPERSEDED" },
      { fetch: fetchFn, endpoints: ENDPOINTS },
    );
    expect(report.proof_state).toBe("MANIFEST_SUPERSEDED");
  });

  it("matches a listed payment against the USDC transfer on chain", async () => {
    const { keys, signed } = await signedCommitManifest([PAYMENT]);
    const { fetchFn } = chain({ note: noteFor(signed.payload_hash) });
    const report = await verifyProof({ signed, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID } }, { fetch: fetchFn, endpoints: ENDPOINTS });
    expect([report.proof_state, report.payments]).toEqual([
      "PROOF_VERIFIED",
      [{ txid: PAYMENT_TXID, network: TESTNET, state: "MATCHED", round: 880 }],
    ]);
  });

  it("downgrades the proof when the chain contradicts a listed payment", async () => {
    // #given a manifest that claims 0.25 USDC while the chain shows 0.10
    const { keys, signed } = await signedCommitManifest([PAYMENT]);
    const { fetchFn } = chain({ note: noteFor(signed.payload_hash), transfer: { amount: 100_000 } });

    const report = await verifyProof({ signed, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID } }, { fetch: fetchFn, endpoints: ENDPOINTS });

    // #then the anchor still holds but the proof is only partial, with the reason named
    expect([report.proof_state, report.payments[0]]).toEqual([
      "PROOF_PARTIAL",
      { txid: PAYMENT_TXID, network: TESTNET, state: "MISMATCH", reason: "WRONG_AMOUNT" },
    ]);
  });

  it("catches a transaction manifest whose decision log was cut after signing", async () => {
    const key = await generateSigningKey("intyr-test");
    const manifest = await buildTransactionManifest({
      manifest_id: "man_2",
      trip_id: "trp_000000000000000000000001",
      environment: "TESTNET",
      created_at: NOW.toISOString(),
      commit_manifest_hash: HASH,
      final_state: "COMMITTED",
      components: [component("cmp_hotel")],
      decisions: [
        { decision_id: "dec_1", gate: "COMMIT", outcome: "ACT", reason_codes: ["ALL_CHECKS_PASSED"], decision_hash: HASH },
        { decision_id: "dec_2", gate: "COMPONENT_CONFIRM", outcome: "ACT", reason_codes: ["SUPPLIER_CONFIRMED"], decision_hash: "sha256:" + "c".repeat(64) },
      ],
      non_actions: [],
      inbound_payments: [],
      outbound_payments: [],
      anchors: [],
      stranded_spend_minor: 0,
      assurance: { mode: "NONE" },
    });
    const valid = await signTransactionManifest(key, manifest);
    const cut = await signDocument(key, "intyr/transaction/v1", { ...manifest, decisions: manifest.decisions.slice(1) });
    const keys = [publishedKey(key, NOW.toISOString())];
    const [validReport, cutReport] = await Promise.all([
      verifyProof({ signed: valid, keys, anchor: null }, { endpoints: ENDPOINTS }),
      verifyProof({ signed: cut, keys, anchor: null }, { endpoints: ENDPOINTS }),
    ]);
    expect([validReport.proof_state, cutReport.proof_state, cutReport.integrity]).toEqual([
      "PROOF_PARTIAL",
      "HASH_MISMATCH",
      { ok: false, reason: "DECISIONS_ROOT_MISMATCH" },
    ]);
  });
});

describe("verifyProof on a signed commit plan", () => {
  it("verifies the plan's signature and marks its caller-described legs as caller asserted", async () => {
    // #given a plan signed the way POST /trips/check returns it
    const key = await generateSigningKey("intyr-test");
    const request = CheckRequestSchema.parse({
      currency: "USD",
      legs: [
        {
          leg_id: "hotel",
          type: "HOTEL",
          supplier: "x",
          offer_ref: "o",
          price: { amount_minor: 100, currency: "USD" },
          preparation_mode: "HARD_HOLD",
          refundable: true,
        },
      ],
    });
    const signed = await checkTrip(request, { now: NOW, environment: "TESTNET", key });

    // #when it is verified without an anchor
    const report = await verifyProof({ signed, keys: [publishedKey(key, NOW.toISOString())], anchor: null }, { endpoints: ENDPOINTS });

    // #then the signature holds, the report names the plan, and it claims no roots a plan does not have
    expect([
      report.integrity,
      report.proof_state,
      report.manifest_id,
      report.evidence_banner,
      report.scope.proves.some((line) => line.includes("roots")),
    ]).toEqual([{ ok: true }, "PROOF_PARTIAL", signed.payload.plan_id, "CALLER_ASSERTED", false]);
  });
});

describe("renderReport", () => {
  it("states the result, what it proves and what it does not", async () => {
    const { keys, signed } = await signedCommitManifest();
    const { fetchFn } = chain({ note: noteFor(signed.payload_hash) });
    const report = await verifyProof({ signed, keys, anchor: { network: TESTNET, txid: ANCHOR_TXID } }, { fetch: fetchFn, endpoints: ENDPOINTS });
    const text = renderReport(report, TESTNET);
    expect([
      text.includes("PROOF_VERIFIED: Verified. Signed by Intyr, unchanged since signing, and anchored on Algorand testnet in round 900."),
      text.includes("It does not show:"),
      text.includes("contains SIMULATED components"),
    ]).toEqual([true, true, true]);
  });
});

describe("renderReport for a partial proof", () => {
  it("names the gap that kept the proof partial", async () => {
    const { keys, signed } = await signedCommitManifest();
    const report = await verifyProof({ signed, keys, anchor: null }, { endpoints: ENDPOINTS });
    expect(renderReport(report)).toContain(
      "PROOF_PARTIAL: Partly verified. The signature and content check out. It has no anchor on Algorand yet, so its timing is unproven.",
    );
  });
});

describe("parseArgs", () => {
  it("reads a manifest id with a pinned key for the sandbox", () => {
    expect(parseArgs(["man_1", "--sandbox", "--key", "abc", "--json"])).toEqual({
      target: "man_1",
      host: "https://intyr.timjosh507.workers.dev",
      sandbox: true,
      key: "abc",
      json: true,
    });
  });

  it("rejects an option without its value", () => {
    expect(parseArgs(["man_1", "--key"])).toEqual({ error: "--key needs a value" });
  });

  it("requires a manifest id or URL", () => {
    expect(parseArgs([])).toEqual({ error: "a manifest id or URL is required" });
  });
});
