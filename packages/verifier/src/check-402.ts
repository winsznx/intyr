import { pathToFileURL } from "node:url";
import { checkHostChallenges } from "./challenge";

const USAGE = `Usage: check-402 [--host <url>] [--testnet]

Calls every paid route listed in the host's /.well-known/x402 with an empty
body and no payment, the way the facilitator's x402 Doctor and listing
refresh do. Each must answer a 402 before validating the body, with x402 V2,
the full-hash Algorand network id, USDC, a price a stock client will pay, one
payTo, the challenge tag, a fee payer and a Bazaar example that passes the
route's schema. Mainnet by default. --testnet probes the /sandbox/v1 mirror.
Exit code 0 means every route passed.`;

export async function main(argv: string[]): Promise<number> {
  let host = "https://intyr.timjosh507.workers.dev";
  let network: "mainnet" | "testnet" = "mainnet";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) host = argv[++i]!.replace(/\/+$/, "");
    else if (argv[i] === "--testnet") network = "testnet";
    else if (argv[i] === "--mainnet") network = "mainnet";
    else {
      console.error(USAGE);
      return 2;
    }
  }
  const { payTo, checks } = await checkHostChallenges(host, network);
  if (checks.length === 0) {
    console.log(`${host}/.well-known/x402 lists no ${network} paid routes.`);
    return 1;
  }
  console.log(`${network} paid routes on ${host}, payTo ${payTo ?? "NOT UNIQUE"}`);
  for (const c of checks) {
    const detail = c.ok ? `402, ${Number(c.amount) / 1_000_000} USDC` : `${c.status}: ${c.problems.join(", ")}`;
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${new URL(c.url).pathname}  ${detail}`);
  }
  const passed = payTo !== null && checks.every((c) => c.ok);
  console.log(passed ? "All paid routes pass." : "Some paid routes fail.");
  return passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
