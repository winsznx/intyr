import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | Error | undefined;
  loading: boolean;
  /** True after the first response, so later polls do not flash a loading state. */
  loaded: boolean;
  reload: () => void;
}

interface Options<T> {
  /** Poll interval in ms while `shouldPoll(data)` is true. */
  pollMs?: number;
  shouldPoll?: (data: T | undefined) => boolean;
  enabled?: boolean;
}

/**
 * Loads server state and keeps it fresh. The page always renders what the server
 * returned last. It never advances state on its own.
 */
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>, options: Options<T> = {}): Resource<T> {
  const { pollMs, shouldPoll, enabled = true } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | Error | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const shouldPollRef = useRef(shouldPoll);
  shouldPollRef.current = shouldPoll;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    setLoaded(false);
  }, [key]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      try {
        const result = await loadRef.current(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(undefined);
        setLoaded(true);
        if (pollMs && shouldPollRef.current?.(result)) {
          timer = setTimeout(tick, pollMs);
        }
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setLoaded(true);
        if (pollMs) timer = setTimeout(tick, Math.min(pollMs * 3, 15_000));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const tick = () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(tick, pollMs ?? 2000);
        return;
      }
      void run();
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [key, nonce, enabled, pollMs]);

  return { data, error, loading, loaded, reload };
}
