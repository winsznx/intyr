import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { explorerTxUrl, lookupTransaction, NETWORKS, preregistrationNote, submitNoteTransaction, type NetworkName } from "@intyr/chain";

/**
 * Anchors the sha256 of a pre-registration document in an Algorand note
 * transaction, so anyone can check that the predictions existed on chain at a
 * given round. The note prefix (intyr:prereg:v1:) cannot be mistaken for a
 * manifest anchor. The document itself must already be committed to git.
 */

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string", default: join(here, "../EVAL_CAMPAIGN.md") },
      network: { type: "string", default: "testnet" },
      role: { type: "string", default: "testnet_payer" },
      out: { type: "string", default: join(here, "../../../evidence/campaign-001/preregistration-anchor.json") },
    },
  });
  const network = NETWORKS[values.network as NetworkName];
  if (!network) throw new Error(`unknown network ${values.network}`);
  const keys = JSON.parse(readFileSync(join(homedir(), ".intyr", "keys.json"), "utf8")) as Record<string, { address: string; mnemonic: string }>;
  const signer = keys[values.role];
  if (!signer) throw new Error(`role ${values.role} not in ~/.intyr/keys.json`);

  const documentSha256 = createHash("sha256").update(readFileSync(values.file)).digest("hex");
  const note = preregistrationNote(documentSha256);
  const submitted = await submitNoteTransaction(network, { mnemonic: signer.mnemonic }, note);
  if (!("txid" in submitted)) throw new Error(`submission failed: ${JSON.stringify(submitted)}`);

  let lookup = await lookupTransaction(network, submitted.txid);
  for (let i = 0; i < 10 && lookup.state === "PENDING"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    lookup = await lookupTransaction(network, submitted.txid);
  }
  const record = {
    document: values.file.replace(/^.*packages\//, "packages/"),
    document_sha256: documentSha256,
    note,
    network: network.name,
    sender: signer.address,
    txid: submitted.txid,
    submit_state: submitted.state,
    lookup,
    explorer: explorerTxUrl(network, submitted.txid),
    anchored_at: new Date().toISOString(),
  };
  writeFileSync(values.out, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
