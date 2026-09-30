import { api, PUBLIC, SANDBOX } from "../lib/api";
import type { PriceRoute, PriceTable } from "../lib/types";
import { useResource, type Resource } from "../lib/use-resource";
import { Button, Skeleton } from "./ui";

export interface LivePrices {
  table: PriceTable;
  /** True when the Mainnet table did not answer and the TestNet sandbox table is shown instead. */
  fromSandbox: boolean;
}

async function loadPrices(signal: AbortSignal): Promise<LivePrices> {
  try {
    return { table: await api.getPrices(PUBLIC, signal), fromSandbox: false };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { table: await api.getPrices(SANDBOX, signal), fromSandbox: true };
  }
}

/** Reads the price list from the API. Mainnet first, then the TestNet sandbox. Prices are never baked into the page. */
export function useLivePrices(): Resource<LivePrices> {
  return useResource("live-prices", loadPrices);
}

export function isSandboxPrices(prices: LivePrices): boolean {
  return prices.fromSandbox || prices.table.environment === "TESTNET";
}

export function findRoute(table: PriceTable, pathSuffix: string): PriceRoute | undefined {
  return table.routes.find((route) => route.path.endsWith(pathSuffix));
}

/** "0.1" becomes "0.10 USDC". Values the API sends in another shape are shown as sent. */
export function formatUsdc(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return `${value} USDC`;
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")} USDC`;
}

function sentenceCase(text: string | undefined): string {
  if (!text) return "Not stated";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const SKELETON_ROWS = 5;

export function LivePriceTable({ prices }: { prices: Resource<LivePrices> }) {
  const { data, error, loading, reload } = prices;
  const failed = !data && !loading && error !== undefined;
  const sandbox = data ? isSandboxPrices(data) : false;

  return (
    <div className="lp-prices" aria-busy={!data && loading}>
      <div className="lp-prices-head">
        <p className="lp-prices-title" aria-live="polite">
          {data ? (sandbox ? "TestNet sandbox prices" : "Algorand Mainnet prices") : failed ? "Prices" : "Loading prices"}
        </p>
        {data ? (
          <p className="meta">
            {sandbox ? "TestNet USDC over x402" : "USDC over x402 on Algorand Mainnet"}, asset <span className="mono">{data.table.asset}</span>
            {sandbox ? ". Calls from the browser sandbox are sponsored and move no USDC." : null}
          </p>
        ) : failed ? null : (
          <span className="lp-prices-meta-skeleton" aria-hidden>
            <Skeleton width={260} height={12} />
          </span>
        )}
      </div>

      <div className="lp-prices-body">
        {failed ? (
          <div className="lp-prices-error" role="status">
            <p className="card-title">Prices are not available right now</p>
            <p className="muted">The API did not answer this request. Reading prices is free, so trying again costs nothing.</p>
            <Button variant="secondary" size="sm" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : (
          <table className="lp-price-table" role="table">
            <caption className="visually-hidden">{data ? (sandbox ? "TestNet sandbox prices" : "Algorand Mainnet prices") : "Loading prices"}</caption>
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">
                  Call
                </th>
                <th role="columnheader" scope="col">
                  What it returns
                </th>
                <th role="columnheader" scope="col">
                  Fee rule
                </th>
                <th role="columnheader" scope="col" className="lp-pt-price">
                  Price
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {data
                ? data.table.routes.map((route) => (
                    <tr role="row" key={`${route.method} ${route.path}`}>
                      <td role="cell" className="lp-pt-call">
                        <span className="lp-pt-name">{route.name}</span>
                        <code className="lp-pt-path">
                          {route.method} {route.path}
                        </code>
                      </td>
                      <td role="cell" className="lp-pt-returns" data-label="What it returns">
                        {sentenceCase(route.unique_output)}
                      </td>
                      <td role="cell" className="lp-pt-fee" data-label="Fee rule">
                        {sentenceCase(route.fee_disposition)}
                      </td>
                      <td role="cell" className="lp-pt-price">
                        {formatUsdc(route.price_usdc)}
                      </td>
                    </tr>
                  ))
                : Array.from({ length: SKELETON_ROWS }, (_, index) => (
                    <tr role="row" key={index} aria-hidden>
                      <td role="cell" className="lp-pt-call">
                        <Skeleton width="70%" height={15} />
                        <span className="lp-pt-path">
                          <Skeleton width="85%" height={12} />
                        </span>
                      </td>
                      <td role="cell" className="lp-pt-returns" data-label="What it returns">
                        <span className="lp-skeleton-lines">
                          <Skeleton height={13} />
                          <Skeleton width="60%" height={13} />
                        </span>
                      </td>
                      <td role="cell" className="lp-pt-fee" data-label="Fee rule">
                        <span className="lp-skeleton-lines">
                          <Skeleton height={13} />
                          <Skeleton width="45%" height={13} />
                        </span>
                      </td>
                      <td role="cell" className="lp-pt-price">
                        <Skeleton width={72} height={14} />
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        )}
      </div>

      {data ? (
        data.table.note ? (
          <p className="lp-prices-note">{data.table.note}</p>
        ) : null
      ) : failed ? null : (
        <span className="lp-prices-note" aria-hidden>
          <Skeleton width="55%" height={12} />
        </span>
      )}
    </div>
  );
}
