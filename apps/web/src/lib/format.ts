import type { Money } from "./types";

const CURRENCY_DIGITS: Record<string, number> = { JPY: 0, KRW: 0, USDC: 6 };

export function formatMoney(money: Money | undefined | null): string {
  if (!money || !Number.isFinite(money.amount_minor)) return "Not priced";
  const digits = CURRENCY_DIGITS[money.currency] ?? 2;
  const value = money.amount_minor / 10 ** digits;
  if (money.currency === "USDC") return `${value.toFixed(value < 1 ? 3 : 2)} USDC`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency, maximumFractionDigits: digits }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${money.currency}`;
  }
}

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "Not set";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** "in 14 min", "2 h ago". Returns null when the timestamp is missing or unreadable. */
export function relativeTime(iso: string | undefined | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000
      ? `${Math.max(1, Math.round(abs / 1000))} s`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 172_800_000
          ? `${Math.round(abs / 3_600_000)} h`
          : `${Math.round(abs / 86_400_000)} d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function shortId(id: string | undefined | null, head = 10, tail = 6): string {
  if (!id) return "";
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function algoExplorerTx(txid: string, network: "MAINNET" | "TESTNET" | string | undefined): string {
  const base = network === "TESTNET" || (typeof network === "string" && network.includes("SGO1GKSzy")) ? "https://lora.algokit.io/testnet" : "https://lora.algokit.io/mainnet";
  return `${base}/transaction/${encodeURIComponent(txid)}`;
}
