import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { paidCall } from "./pay";
import { balances, loadWallet, NETWORKS, optInUsdc, sendUsdc, type NetworkName } from "./wallet";

const DEFAULT_BASE = process.env.INTYR_BASE_URL ?? "https://intyr.timjosh507.workers.dev";

const USAGE = `Intyr reference agent. Pays Intyr endpoints over x402 on Algorand.

Usage: pnpm --filter @intyr/example-agent agent <command> [options]

Commands
  balance                     Show ALGO and USDC for the signer
  optin                       Opt the signer in to USDC (needs about 0.2 ALGO)
  send <address> <usdc>       Send USDC from the signer (TestNet funding between test roles)
  call <METHOD> <path>        Call a paid or free route, paying the 402 challenge if one comes back
  check <legs.json>           POST the file to /trips/check
  prepare <intent.json>       POST the file to /trips/prepare

Options
  --network testnet|mainnet   Default testnet
  --role <name>               Key role in ~/.intyr/keys.json (default testnet_payer). AVM_MNEMONIC overrides it
  --base <url>                Default ${DEFAULT_BASE}
  --sandbox                   Use /sandbox/v1 routes (TestNet) instead of /v1
  --body <file>               JSON body for call
  --max <usd>                 Per-payment cap enforced before signing (default $1)
`;

function print(value: unknown): void {
  console.log(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      network: { type: "string", default: "testnet" },
      role: { type: "string", default: "testnet_payer" },
      base: { type: "string", default: DEFAULT_BASE },
      sandbox: { type: "boolean", default: false },
      body: { type: "string" },
      max: { type: "string", default: "$1" },
      help: { type: "boolean", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }
  const networkName = values.network as NetworkName;
  if (!(networkName in NETWORKS)) throw new Error(`unknown network ${networkName}`);
  const network = NETWORKS[networkName];
  const wallet = loadWallet(values.role);
  const prefix = values.sandbox ? "/sandbox/v1" : "/v1";
  const url = (path: string): string => `${values.base.replace(/\/$/, "")}${path}`;

  switch (command) {
    case "balance": {
      const b = await balances(network, wallet.address);
      print({ network: network.name, source: wallet.source, ...b, algo: Number(b.microAlgos) / 1e6, usdc: Number(b.usdcMicro) / 1e6 });
      return;
    }
    case "optin": {
      const b = await balances(network, wallet.address);
      if (b.usdcOptedIn) {
        print({ address: wallet.address, already_opted_in: true });
        return;
      }
      const res = await optInUsdc(network, wallet);
      print({ address: wallet.address, opted_in: true, ...res, explorer: `${network.explorer}/transaction/${res.txid}` });
      return;
    }
    case "send": {
      const [to, amount] = args;
      if (!to || !amount) throw new Error("send <address> <usdc>");
      const micro = BigInt(Math.round(Number.parseFloat(amount) * 1e6));
      const res = await sendUsdc(network, wallet, to, micro);
      print({ from: wallet.address, to, usdc: amount, ...res, explorer: `${network.explorer}/transaction/${res.txid}` });
      return;
    }
    case "call": {
      const [method, path] = args;
      if (!method || !path) throw new Error("call <METHOD> <path>");
      print(await paidCall(wallet, networkName, url(path), { method: method.toUpperCase(), body: values.body ? readJson(values.body) : undefined }, values.max));
      return;
    }
    case "check":
    case "prepare": {
      const [file] = args;
      if (!file) throw new Error(`${command} <file.json>`);
      print(await paidCall(wallet, networkName, url(`${prefix}/trips/${command}`), { method: "POST", body: readJson(file) }, values.max));
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
