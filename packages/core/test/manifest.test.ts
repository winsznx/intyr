import { describe, expect, it } from "vitest";
import { hashValue, sha256Hex } from "../src/hash";
import {
  buildCommitManifest,
  buildTransactionManifest,
  componentRoot,
  evidenceBanner,
  integrityProofState,
  merkleRoot,
  signCommitManifest,
  signTransactionManifest,
  statusRecord,
  verifyManifestDocument,
  type CommitManifestInput,
} from "../src/manifest";
import { generateSigningKey, publishedKey, signDocument } from "../src/sign";
import { HASH_A, HASH_B, inMinutes, manifestComponent, NOW, TRIP_ID } from "./fixtures";

const hex = (hash: string) => hash.slice("sha256:".length);

async function leaves(...names: string[]) {
  return Promise.all(names.map((n) => hashValue(JSON.stringify(n))));
}

describe("merkleRoot", () => {
  it("returns a fixed, domain-separated root for no leaves", async () => {
    expect(await merkleRoot([])).toBe("sha256:" + (await sha256Hex("intyr/empty-root")));
  });

  it("returns the leaf itself for a single leaf", async () => {
    const [a] = await leaves("a");
    expect(await merkleRoot([a!])).toBe(a);
  });

  it("hashes the concatenated hex of a pair", async () => {
    const [a, b] = await leaves("a", "b");
    expect(await merkleRoot([a!, b!])).toBe("sha256:" + (await sha256Hex(hex(a!) + hex(b!))));
  });

  it("pairs an odd node with itself", async () => {
    const [a, b, c] = await leaves("a", "b", "c");
    const ab = await sha256Hex(hex(a!) + hex(b!));
    const cc = await sha256Hex(hex(c!) + hex(c!));
    expect(await merkleRoot([a!, b!, c!])).toBe("sha256:" + (await sha256Hex(ab + cc)));
  });

  it("depends on leaf order", async () => {
    const [a, b] = await leaves("a", "b");
    expect(await merkleRoot([a!, b!])).not.toBe(await merkleRoot([b!, a!]));
  });
});

describe("evidenceBanner", () => {
  it.each([
    { grades: ["SUPPLIER_SANDBOX", "SIMULATED", "CALLER_ASSERTED"], banner: "SIMULATED" },
    { grades: ["SUPPLIER_SANDBOX", "CALLER_ASSERTED"], banner: "CALLER_ASSERTED" },
    { grades: ["SUPPLIER_SANDBOX", "SUPPLIER_PRODUCTION"], banner: "SUPPLIER_SANDBOX" },
    { grades: ["SUPPLIER_PRODUCTION", "SUPPLIER_SIGNED"], banner: "NONE" },
  ] as const)("shows $banner for $grades", ({ grades, banner }) => {
    expect(evidenceBanner(grades.map((g, i) => manifestComponent(`cmp_${i}`, g)))).toBe(banner);
  });
});

function commitManifestInput(): CommitManifestInput {
  const components = [manifestComponent("cmp_hotel"), manifestComponent("cmp_flight", "SIMULATED")];
  return {
    manifest_id: "man_1",
    trip_id: TRIP_ID,
    environment: "TESTNET",
    created_at: NOW.toISOString(),
    expires_at: inMinutes(10),
    intent_hash: HASH_A,
    currency: "USD",
    total_minor: 40_000,
    components,
    commit_order: ["cmp_hotel", "cmp_flight"],
    readiness: { score: 84, validated: false, model_version: "readiness-0.1.0", basis: "PRIOR", minimum_required: 70 },
    exposure: { total_minor: 40_000, irreversible_minor: 20_000, currency: "USD" },
    decision_log_root: HASH_A,
    non_actions: [],
    recovery_policy: {
      policy_version: "public-default-v1",
      replacement_headroom_minor: 0,
      cancel_reversible_on_failure: true,
      never_replace_while_unknown: true,
    },
    assurance: { mode: "NONE" },
    inbound_payments: [],
  };
}

async function keys() {
  const key = await generateSigningKey("key-2026-10");
  return { key, published: [publishedKey(key, NOW.toISOString())] };
}

describe("commit manifest", () => {
  it("commits to its components through the component root", async () => {
    const manifest = await buildCommitManifest(commitManifestInput());
    expect(manifest.component_root).toBe(await componentRoot(manifest.components));
  });

  it("carries the weakest evidence grade as its banner", async () => {
    expect((await buildCommitManifest(commitManifestInput())).evidence_banner).toBe("SIMULATED");
  });

  it("verifies offline after signing", async () => {
    const { key, published } = await keys();
    const signed = await signCommitManifest(key, await buildCommitManifest(commitManifestInput()));
    expect(await verifyManifestDocument(signed, published)).toEqual({ ok: true });
  });

  it("catches a component edited under a validly re-signed but stale root", async () => {
    // #given a manifest whose component was changed without recomputing the root
    const { key, published } = await keys();
    const manifest = await buildCommitManifest(commitManifestInput());
    const edited = {
      ...manifest,
      components: manifest.components.map((c, i) => (i === 0 ? { ...c, price: { ...c.price, amount_minor: 1 } } : c)),
    };

    // #when it is signed anyway and verified
    const signed = await signDocument(key, "intyr/manifest/v1", edited);

    // #then the recomputed root exposes the edit
    expect(await verifyManifestDocument(signed, published)).toEqual({ ok: false, reason: "COMPONENT_ROOT_MISMATCH" });
  });

  it("does not verify a commit manifest signed in the transaction context", async () => {
    const { key, published } = await keys();
    const signed = await signDocument(key, "intyr/transaction/v1", await buildCommitManifest(commitManifestInput()));
    expect(await verifyManifestDocument(signed, published)).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });
});

describe("transaction manifest", () => {
  it("commits to its decisions through the decisions root and verifies after signing", async () => {
    // #given two decisions recorded during the commit
    const { key, published } = await keys();
    const decisions = [
      { decision_id: "dec_1", gate: "COMMIT" as const, outcome: "ACT" as const, reason_codes: ["ALL_CHECKS_PASSED" as const], decision_hash: HASH_A },
      {
        decision_id: "dec_2",
        gate: "COMPONENT_CONFIRM" as const,
        outcome: "ACT" as const,
        reason_codes: ["SUPPLIER_CONFIRMED" as const],
        decision_hash: "sha256:" + "c".repeat(64),
      },
    ];

    // #when the transaction manifest is built and signed
    const manifest = await buildTransactionManifest({
      manifest_id: "man_2",
      trip_id: TRIP_ID,
      environment: "TESTNET",
      created_at: NOW.toISOString(),
      commit_manifest_hash: HASH_A,
      final_state: "COMMITTED",
      components: [manifestComponent("cmp_hotel")],
      decisions,
      non_actions: [],
      inbound_payments: [],
      outbound_payments: [],
      anchors: [],
      stranded_spend_minor: 0,
      assurance: { mode: "NONE" },
    });
    const signed = await signTransactionManifest(key, manifest);

    // #then its roots match and the signature verifies
    expect([
      manifest.decisions_root === (await merkleRoot(decisions.map((d) => d.decision_hash))),
      await verifyManifestDocument(signed, published),
    ]).toEqual([true, { ok: true }]);
  });
});

describe("transaction manifest decisions root", () => {
  it("catches a decision log edited under a validly re-signed but stale root", async () => {
    // #given a transaction manifest whose decision list lost an entry after the root was computed
    const { key, published } = await keys();
    const manifest = await buildTransactionManifest({
      manifest_id: "man_3",
      trip_id: TRIP_ID,
      environment: "TESTNET",
      created_at: NOW.toISOString(),
      commit_manifest_hash: HASH_A,
      final_state: "RECOVERED",
      components: [manifestComponent("cmp_hotel")],
      decisions: [
        { decision_id: "dec_1", gate: "COMMIT", outcome: "ACT", reason_codes: ["ALL_CHECKS_PASSED"], decision_hash: HASH_A },
        { decision_id: "dec_2", gate: "RECOVERY_ACTION", outcome: "ACT", reason_codes: ["CANCEL_WITHIN_FREE_WINDOW"], decision_hash: HASH_B },
      ],
      non_actions: [],
      inbound_payments: [],
      outbound_payments: [],
      anchors: [],
      stranded_spend_minor: 0,
      assurance: { mode: "NONE" },
    });
    const edited = { ...manifest, decisions: manifest.decisions.slice(0, 1) };

    // #when it is signed anyway and verified
    const check = await verifyManifestDocument(await signDocument(key, "intyr/transaction/v1", edited), published);

    // #then the recomputed decisions root exposes the edit, reported as a hash mismatch
    expect([check, integrityProofState(check)]).toEqual([{ ok: false, reason: "DECISIONS_ROOT_MISMATCH" }, "HASH_MISMATCH"]);
  });
});

describe("integrityProofState", () => {
  it.each([
    { reason: "HASH_MISMATCH", state: "HASH_MISMATCH" },
    { reason: "COMPONENT_ROOT_MISMATCH", state: "HASH_MISMATCH" },
    { reason: "DECISIONS_ROOT_MISMATCH", state: "HASH_MISMATCH" },
    { reason: "SIGNATURE_INVALID", state: "SIGNATURE_INVALID" },
    { reason: "UNKNOWN_KEY", state: "SIGNATURE_INVALID" },
    { reason: "KEY_REVOKED", state: "SIGNATURE_INVALID" },
  ] as const)("reports $reason as $state", ({ reason, state }) => {
    expect(integrityProofState({ ok: false, reason })).toBe(state);
  });

  it("reports nothing for a document that verifies", () => {
    expect(integrityProofState({ ok: true })).toBeNull();
  });
});

describe("statusRecord", () => {
  it("records a supersession without touching the signed manifest", () => {
    expect(statusRecord("man_1", HASH_A, "SUPERSEDED", NOW, "man_2")).toEqual({
      schema_version: "manifest-status/1",
      manifest_id: "man_1",
      manifest_hash: HASH_A,
      status: "SUPERSEDED",
      superseded_by: "man_2",
      at: NOW.toISOString(),
    });
  });
});
