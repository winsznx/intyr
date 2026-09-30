import type { Env } from "./env";
import { networkConfig } from "./config";
import { createLadder, reconcileSession } from "./payments/ladder";
import { listStaleSessions } from "./payments/sessions";
import { createX402Server } from "./server";
import { createApp } from "./app";
import type { DomainHandlers } from "./domain";
import { createDomain } from "./domain/wire";

const VERSION = { name: "intyr", commit: "dev", contract_versions: { manifest: "v1" } };

function build(env: Env, domainOverride?: DomainHandlers) {
  const net = networkConfig(env);
  const { httpServer } = createX402Server(net, env.PAY_TO, env.FACILITATOR_URL);
  const ladder = createLadder({
    db: env.DB,
    httpServer,
    net,
    payTo: env.PAY_TO,
    teamWallets: (env.TEAM_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  const app = createApp({ env, net, ladder, domain: domainOverride ?? createDomain(env), version: VERSION });
  return { app, net, httpServer };
}

let cache: { env: Env; built: ReturnType<typeof build>; ready: Promise<void> } | null = null;

function get(env: Env) {
  if (!cache || cache.env !== env) {
    const built = build(env);
    cache = { env, built, ready: built.httpServer.initialize() };
  }
  return cache;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { built, ready } = get(env);
    const url = new URL(request.url);
    const isApi =
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/sandbox/") ||
      url.pathname.startsWith("/.well-known/") ||
      ["/healthz", "/version", "/llms.txt", "/openapi.json"].includes(url.pathname);
    if (isApi) {
      if (request.method === "POST" && url.pathname.startsWith("/v1/trips/")) await ready.catch(() => undefined);
      return built.app.fetch(request, env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return built.app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const { built } = get(env);
    ctx.waitUntil(
      (async () => {
        const cutoff = new Date(Date.now() - 20_000).toISOString();
        const stale = await listStaleSessions(env.DB, ["UNKNOWN", "SETTLE_SUBMITTED", "SETTLE_FAILED", "PROOF_RECEIVED"], cutoff);
        for (const session of stale) await reconcileSession({ db: env.DB, net: built.net }, session);
      })(),
    );
  },
};
