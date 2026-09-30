import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkHostChallenges } from "./challenge";

const USAGE = `Usage: check-402 [--host <url>] [--mainnet]

Calls every paid route listed in the host's /.well-known/x402 without paying
and checks each 402 for x402 V2, the full-hash Algorand network id, USDC, a
price a stock client will pay, one payTo, the challenge tag, a fee payer and
a Bazaar declaration. TestNet by default. Exit code 0 means every route passed.`;

const EXAMPLE_REQUESTS = new URL("../../../examples/agent/requests/", import.meta.url);

function exampleBody(file: string): unknown {
  return JSON.parse(readFileSync(new URL(file, EXAMPLE_REQUESTS), "utf8"));
}

export async function main(argv: string[]): Promise<number> {
  let host = "https://intyr.timjosh507.workers.dev";
  let network: "mainnet" | "testnet" = "testnet";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) host = argv[++i]!.replace(/\/+$/, "");
    else if (argv[i] === "--mainnet") network = "mainnet";
    else {
      console.error(USAGE);
      return 2;
    }
  }
  const bodies = { check: exampleBody("check.json"), prepare: exampleBody("prepare.json") };
  const { payTo, checks } = await checkHostChallenges(host, network, bodies);
  if (checks.length === 0) {
    console.log(`${host}/.well-known/x402 lists no ${network} paid routes.`);
    return 1;
  }
  console.log(`${network} paid routes on ${host}, payTo ${payTo ?? "NOT UNIQUE"}`);
  for (const c of checks) {
    const verdict = c.ok ? "PASS" : "FAIL";
    const detail = c.refusedBeforeCharge
      ? `refused before charge (${c.status}), no trip given`
      : c.ok
        ? `402, ${Number(c.amount) / 1_000_000} USDC`
        : c.problems.join(", ");
    console.log(`  ${verdict}  ${new URL(c.url).pathname}  ${detail}`);
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
