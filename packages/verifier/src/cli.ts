import { pathToFileURL } from "node:url";
import type { ManifestStatus, PublishedKey, Signed } from "@intyr/core";
import { renderReport } from "./report";
import { verifyProof, type VerifiableManifest } from "./verify";

const USAGE = `Usage: intyr-verify <manifest-id | manifest-url> [options]

Checks an Intyr manifest against its published signing key and the public
Algorand record. Chain reads go to public Nodely nodes, never to Intyr.

Options:
  --host <url>             Intyr host (default https://intyr.timjosh507.workers.dev)
  --sandbox                Read the manifest from /sandbox/v1 instead of /v1
  --key <base64url>        Pin the expected Ed25519 public key instead of trusting the host's key set
  --anchor-account <addr>  Only accept an anchor sent by this account (default: the host's published anchor_accounts)
  --json                   Print the full report as JSON

Exit code 0 means PROOF_VERIFIED, 1 any other proof state, 2 a usage or fetch error.`;

export interface CliArgs {
  target: string;
  host: string;
  sandbox: boolean;
  key?: string;
  anchorAccount?: string;
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs | { error: string } {
  const args: CliArgs = { target: "", host: "https://intyr.timjosh507.workers.dev", sandbox: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "--host") args.host = value().replace(/\/+$/, "");
      else if (arg === "--sandbox") args.sandbox = true;
      else if (arg === "--key") args.key = value();
      else if (arg === "--anchor-account") args.anchorAccount = value();
      else if (arg === "--json") args.json = true;
      else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
      else if (!args.target) args.target = arg;
      else return { error: `unexpected argument ${arg}` };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return args.target ? args : { error: "a manifest id or URL is required" };
}

/**
 * The keys to verify against. A pinned key replaces the host's key list
 * entirely, so a compromised host can't swap the key a record is checked with.
 */
export function keysFor(published: PublishedKey[], signedKeyId: string, pinned?: string): PublishedKey[] {
  if (!pinned) return published;
  return [{ key_id: signedKeyId, alg: "Ed25519", public_key: pinned, valid_from: "", valid_to: null, revoked: false }];
}

interface ManifestRead {
  manifest_id: string;
  status?: ManifestStatus;
  anchor: { network: string; txid: string | null } | null;
  signed: Signed<VerifiableManifest>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return (await res.json()) as T;
}

function manifestUrl(args: CliArgs): string {
  if (/^https?:\/\//.test(args.target)) return args.target;
  return `${args.host}${args.sandbox ? "/sandbox/v1" : "/v1"}/manifests/${encodeURIComponent(args.target)}`;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  try {
    const read = await getJson<ManifestRead>(manifestUrl(args));
    const host = /^https?:\/\//.test(args.target) ? new URL(args.target).origin : args.host;
    const published = await getJson<{ keys: PublishedKey[]; anchor_accounts?: Record<string, string> }>(
      `${host}/.well-known/intyr-signing-keys.json`,
    );
    const keys = keysFor(published.keys, read.signed.signature.key_id, args.key);
    const anchor = read.anchor?.txid ? { network: read.anchor.network, txid: read.anchor.txid } : null;
    const anchorAccounts =
      anchor && args.anchorAccount ? { ...published.anchor_accounts, [anchor.network]: args.anchorAccount } : published.anchor_accounts;
    const report = await verifyProof({
      signed: read.signed,
      keys,
      anchor,
      ...(read.status ? { status: read.status } : {}),
      ...(anchorAccounts && Object.keys(anchorAccounts).length > 0 ? { anchorAccounts } : {}),
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : renderReport(report, anchor?.network));
    if (!args.json) {
      console.log(
        args.key
          ? `\nChecked against the pinned key, not the host's key list.`
          : `\nKeys were read from ${host}. Pin one with --key to check against an independent copy.`,
      );
    }
    return report.proof_state === "PROOF_VERIFIED" ? 0 : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e);
      process.exit(2);
    },
  );
}
