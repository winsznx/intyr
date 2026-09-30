import type { Env } from "./env";
import { networkConfig, routePrefix, type NetworkConfig } from "./config";
import { createLadder, reconcileSession } from "./payments/ladder";
import { listStaleSessions } from "./payments/sessions";
import { createX402Server } from "./server";
import { createApp, type NetworkDeps } from "./app";
import { createDomain, type Domain } from "./domain/wire";
import { openFeeRefund, reconcileRefunds, summarize } from "./payments/refunds";

const VERSION = { name: "intyr", commit: "dev", contract_versions: { manifest: "v1" } };

function buildNetwork(env: Env, name: "mainnet" | "testnet", payTo: string) {
  const net = networkConfig(name, env);
  const environment = name === "mainnet" ? "MAINNET" : "TESTNET";
  const { httpServer } = createX402Server(net, payTo, env.FACILITATOR_URL);
  const ladder = createLadder({
    db: env.DB,
    httpServer,
    net,
    payTo,
    teamWallets: (env.TEAM_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    openRefund: ({ session, delivery, tripId }) => openFeeRefund(env.DB, { session, environment, delivery, tripId, now: new Date() }).then(summarize),
  });
  const domain: Domain = createDomain(env, environment);
  const deps: NetworkDeps = { net, payTo, ladder, domain: domain.handlers };
  const refundMnemonic = name === "testnet" ? env.PAYTO_MNEMONIC_TESTNET : undefined;
  const reconcile = async (): Promise<number> => (await domain.reconcile()) + (refundMnemonic ? await reconcileRefunds(env.DB, { net, mnemonic: refundMnemonic }, new Date()) : 0);
  return { deps, init: () => httpServer.initialize(), net, reconcile };
}

function build(env: Env) {
  const mainnet = env.PAY_TO_MAINNET ? buildNetwork(env, "mainnet", env.PAY_TO_MAINNET) : undefined;
  const testnet = env.PAY_TO_TESTNET ? buildNetwork(env, "testnet", env.PAY_TO_TESTNET) : undefined;
  const app = createApp({ env, mainnet: mainnet?.deps, testnet: testnet?.deps, version: VERSION });
  const nets: NetworkConfig[] = [mainnet?.net, testnet?.net].filter((n): n is NetworkConfig => Boolean(n));
  // A promise created in one request cannot be awaited from another in workerd, so initialization is
  // retried inside whichever request needs it. The resource server keeps the result as plain data.
  const inits = [mainnet?.init, testnet?.init].filter((f): f is () => Promise<void> => Boolean(f));
  const state = { initialized: false };
  const ensureReady = async (): Promise<boolean> => {
    if (state.initialized) return true;
    try {
      await Promise.all(inits.map((f) => f()));
      state.initialized = true;
      return true;
    } catch {
      return false;
    }
  };
  const reconcilers = [mainnet?.reconcile, testnet?.reconcile].filter((f): f is () => Promise<number> => Boolean(f));
  return { app, ensureReady, nets, reconcilers };
}

let cache: { env: Env; built: ReturnType<typeof build> } | null = null;

function get(env: Env) {
  if (!cache || cache.env !== env) cache = { env, built: build(env) };
  return cache.built;
}

const API_PREFIXES = ["/v1/", "/sandbox/", "/.well-known/"];
const API_EXACT = new Set(["/healthz", "/version", "/llms.txt", "/openapi.json"]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const built = get(env);
    const url = new URL(request.url);
    const isApi = API_PREFIXES.some((p) => url.pathname.startsWith(p)) || API_EXACT.has(url.pathname);
    if (isApi) {
      if (request.method === "POST" && !(await built.ensureReady())) {
        return Response.json({ error: "FACILITATOR_UNAVAILABLE", message: "The payment facilitator could not be reached. You were not charged. Retry shortly." }, { status: 503 });
      }
      return built.app.fetch(request, env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return built.app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const built = get(env);
    ctx.waitUntil(
      (async () => {
        const cutoff = new Date(Date.now() - 20_000).toISOString();
        const stale = await listStaleSessions(env.DB, ["UNKNOWN", "SETTLE_SUBMITTED", "SETTLE_FAILED", "PROOF_RECEIVED"], cutoff);
        for (const session of stale) {
          const net = built.nets.find((n) => n.caip2 === session.network);
          if (net) await reconcileSession({ db: env.DB, net }, session);
        }
        for (const reconcile of built.reconcilers) await reconcile();
      })(),
    );
  },
};

export { routePrefix };
